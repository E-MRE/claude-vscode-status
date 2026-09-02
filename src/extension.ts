import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface RateLimit {
  used_percentage?: number;
  resets_at?: number;
}

interface BridgePayload {
  captured_at?: number;
  cwd?: string;
  session_id?: string;
  session_name?: string;
  version?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string; added_dirs?: string[] };
  effort?: { level?: string };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number | null;
    current_usage?: TokenUsage | null;
  };
  rate_limits?: {
    five_hour?: RateLimit;
    seven_day?: RateLimit;
  };
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface NativeTranscriptStatus {
  source: 'native';
  sessionId: string;
  cwd: string;
  transcriptPath: string;
  updatedAt: number;
  entrypoint: string;
  modelId?: string;
  modelName: string;
  effort?: string;
  usage: TokenUsage;
  contextTokens?: number;
  contextWindowSize?: number;
  contextWindowInferred: boolean;
  version?: string;
}

interface DisplayStatus {
  source: 'native' | 'bridge';
  sessionId?: string;
  cwd?: string;
  updatedAt?: number;
  modelName: string;
  effort?: string;
  usage?: TokenUsage;
  contextTokens?: number;
  contextWindowSize?: number;
  contextWindowInferred?: boolean;
  contextPct?: number;
  fiveHour?: RateLimit;
  sevenDay?: RateLimit;
  rateCapturedAt?: number;
  version?: string;
  pinned: boolean;
  sourceDetail: string;
}

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const BRIDGE_DIR = path.join(CLAUDE_DIR, 'vscode-status');
const BRIDGE_SESSIONS_DIR = path.join(BRIDGE_DIR, 'sessions');
const LEGACY_EVENTS_FILE = path.join(BRIDGE_DIR, 'events.jsonl');
const BRIDGE_SCRIPT_SH = path.join(BRIDGE_DIR, 'statusline-bridge.sh');
const BRIDGE_SCRIPT_PS1 = path.join(BRIDGE_DIR, 'statusline-bridge.ps1');
const PREVIOUS_STATUS_FILE = path.join(BRIDGE_DIR, 'previous-statusline.json');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const PINNED_SESSION_KEY = 'claudeVscodeStatus.pinnedSessionId';
const BRIDGE_PROMPTED_KEY = 'claudeVscodeStatus.bridgePromptedV110';
const MAX_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

let statusItem: vscode.StatusBarItem;
let pollTimer: NodeJS.Timeout | undefined;
let extensionContext: vscode.ExtensionContext;
let lastFingerprint = '';
const nativeTranscriptCache = new Map<string, { mtimeMs: number; status?: NativeTranscriptStatus }>();

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Claude Code Status';
  statusItem.text = 'Claude: waiting for data';
  statusItem.tooltip = 'Waiting for Claude Code transcript or local statusLine data.';
  statusItem.command = 'claudeVscodeStatus.selectSession';
  statusItem.show();

  context.subscriptions.push(
    statusItem,
    vscode.commands.registerCommand('claudeVscodeStatus.installBridge', installBridge),
    vscode.commands.registerCommand('claudeVscodeStatus.refresh', refresh),
    vscode.commands.registerCommand('claudeVscodeStatus.selectSession', selectSession),
    vscode.commands.registerCommand('claudeVscodeStatus.clearSession', clearSessionSelection),
    vscode.commands.registerCommand('claudeVscodeStatus.removeBridge', removeBridge),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('claudeVscodeStatus')) {
        startPolling();
        lastFingerprint = '';
        void refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      lastFingerprint = '';
      void refresh();
    })
  );

  startPolling();
  void refresh();
  void offerBridgeSetup();
}

export function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = vscode.workspace.getConfiguration('claudeVscodeStatus').get<number>('refreshInterval', 2);
  pollTimer = setInterval(() => void refresh(), Math.max(1, seconds) * 1000);
}

async function refresh() {
  try {
    const display = await resolveDisplayStatus();
    if (!display) {
      statusItem.text = 'Claude: waiting for data';
      statusItem.tooltip = 'No matching Claude VS Code transcript or statusLine cache was found for this workspace. Send a prompt in Claude Code.';
      return;
    }

    const fingerprint = JSON.stringify(display);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    render(display);
  } catch (error) {
    statusItem.text = 'Claude: status error';
    statusItem.tooltip = error instanceof Error ? error.message : String(error);
  }
}

async function resolveDisplayStatus(): Promise<DisplayStatus | undefined> {
  const roots = workspaceRoots();
  const native = await readNativeTranscriptStatuses(roots);
  const bridge = await readBridgePayloads();
  const pinnedId = extensionContext.workspaceState.get<string>(PINNED_SESSION_KEY);

  if (pinnedId) {
    const pinnedNative = native.find((s) => s.sessionId === pinnedId);
    if (pinnedNative) return combineNativeWithRates(pinnedNative, bridge, true);

    const pinnedBridge = bridge.find((p) => p.session_id === pinnedId);
    if (pinnedBridge) return bridgeToDisplay(pinnedBridge, true);

    await extensionContext.workspaceState.update(PINNED_SESSION_KEY, undefined);
  }

  // Native Claude Code extension transcripts are authoritative for model/context.
  // The most recently updated matching transcript is the conversation that most
  // recently emitted activity in this workspace. A user can pin another one.
  if (native.length > 0) {
    return combineNativeWithRates(native[0], bridge, false);
  }

  const matchingBridge = roots.length > 0 ? bridge.filter((p) => bridgeMatchesWorkspace(p, roots)) : bridge;
  if (matchingBridge.length > 0) return bridgeToDisplay(matchingBridge[0], false);
  return undefined;
}

function combineNativeWithRates(native: NativeTranscriptStatus, bridge: BridgePayload[], pinned: boolean): DisplayStatus {
  const exact = bridge.find((p) => p.session_id === native.sessionId && hasRateLimits(p));
  const sameWorkspace = bridge.find((p) => hasRateLimits(p) && bridgeMatchesWorkspace(p, [normalizePath(native.cwd)]));
  const latestRates = bridge.find(hasRateLimits);
  const rateSource = exact ?? sameWorkspace ?? latestRates;

  const contextPct = typeof native.contextTokens === 'number' && typeof native.contextWindowSize === 'number' && native.contextWindowSize > 0
    ? native.contextTokens / native.contextWindowSize * 100
    : undefined;

  return {
    source: 'native',
    sessionId: native.sessionId,
    cwd: native.cwd,
    updatedAt: native.updatedAt,
    modelName: native.modelName,
    effort: native.effort,
    usage: native.usage,
    contextTokens: native.contextTokens,
    contextWindowSize: native.contextWindowSize,
    contextWindowInferred: native.contextWindowInferred,
    contextPct,
    fiveHour: rateSource?.rate_limits?.five_hour,
    sevenDay: rateSource?.rate_limits?.seven_day,
    rateCapturedAt: rateSource?.captured_at,
    version: native.version ?? rateSource?.version,
    pinned,
    sourceDetail: 'Claude VS Code transcript'
  };
}

function bridgeToDisplay(payload: BridgePayload, pinned: boolean): DisplayStatus {
  return {
    source: 'bridge',
    sessionId: payload.session_id,
    cwd: payload.workspace?.project_dir ?? payload.workspace?.current_dir ?? payload.cwd,
    updatedAt: payload.captured_at,
    modelName: payload.model?.display_name ?? formatModelName(payload.model?.id) ?? 'Claude',
    effort: payload.effort?.level,
    usage: payload.context_window?.current_usage ?? undefined,
    contextTokens: payload.context_window?.total_input_tokens,
    contextWindowSize: payload.context_window?.context_window_size,
    contextWindowInferred: false,
    contextPct: payload.context_window?.used_percentage ?? undefined,
    fiveHour: payload.rate_limits?.five_hour,
    sevenDay: payload.rate_limits?.seven_day,
    rateCapturedAt: payload.captured_at,
    version: payload.version,
    pinned,
    sourceDetail: 'Claude Code statusLine bridge'
  };
}

function hasRateLimits(payload: BridgePayload): boolean {
  return typeof payload.rate_limits?.five_hour?.used_percentage === 'number' || typeof payload.rate_limits?.seven_day?.used_percentage === 'number';
}

async function readNativeTranscriptStatuses(roots: string[]): Promise<NativeTranscriptStatus[]> {
  if (roots.length === 0) return [];
  const transcriptFiles = new Set<string>();

  for (const root of roots) {
    const expected = path.join(PROJECTS_DIR, encodeClaudeProjectPath(root));
    await addJsonlFiles(expected, transcriptFiles);
  }

  // If Claude changes its path encoding, fall back to a bounded scan of project
  // directories and verify cwd from transcript metadata before accepting data.
  if (transcriptFiles.size === 0) {
    try {
      const dirs = await fs.promises.readdir(PROJECTS_DIR, { withFileTypes: true });
      const likely = dirs.filter((d) => d.isDirectory() && roots.some((r) => d.name.includes(path.basename(r))));
      for (const dir of likely.slice(0, 20)) await addJsonlFiles(path.join(PROJECTS_DIR, dir.name), transcriptFiles);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const withStats: Array<{ file: string; mtimeMs: number }> = [];
  for (const file of transcriptFiles) {
    try {
      const stat = await fs.promises.stat(file);
      withStats.push({ file, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore files that rotate/disappear while polling.
    }
  }
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const statuses: NativeTranscriptStatus[] = [];
  for (const item of withStats.slice(0, 20)) {
    const cached = nativeTranscriptCache.get(item.file);
    let parsed: NativeTranscriptStatus | undefined;
    if (cached && cached.mtimeMs === item.mtimeMs) {
      parsed = cached.status;
    } else {
      parsed = await parseNativeTranscript(item.file, item.mtimeMs);
      nativeTranscriptCache.set(item.file, { mtimeMs: item.mtimeMs, status: parsed });
    }
    if (!parsed) continue;
    if (!roots.some((root) => pathsOverlap(normalizePath(parsed.cwd), root))) continue;
    statuses.push(parsed);
  }
  statuses.sort((a, b) => b.updatedAt - a.updatedAt);
  return statuses;
}

async function addJsonlFiles(dir: string, output: Set<string>) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) output.add(path.join(dir, entry.name));
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function parseNativeTranscript(file: string, mtimeMs: number): Promise<NativeTranscriptStatus | undefined> {
  const lines = await readTailLines(file, MAX_TRANSCRIPT_TAIL_BYTES);
  let latestAssistant: any | undefined;
  let latestSessionId: string | undefined;
  let latestCwd: string | undefined;
  let latestVersion: string | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }

    if (!latestSessionId && typeof obj.sessionId === 'string') latestSessionId = obj.sessionId;
    if (!latestCwd && typeof obj.cwd === 'string') latestCwd = obj.cwd;
    if (!latestVersion && typeof obj.version === 'string') latestVersion = obj.version;

    if (!latestAssistant && obj.type === 'assistant' && obj.entrypoint === 'claude-vscode' && obj.message && typeof obj.message === 'object') {
      latestAssistant = obj;
      latestSessionId = typeof obj.sessionId === 'string' ? obj.sessionId : latestSessionId;
      latestCwd = typeof obj.cwd === 'string' ? obj.cwd : latestCwd;
      latestVersion = typeof obj.version === 'string' ? obj.version : latestVersion;
      break;
    }
  }

  if (!latestAssistant || !latestSessionId || !latestCwd) return undefined;
  const usageRaw = latestAssistant.message?.usage;
  const usage: TokenUsage = {
    input_tokens: finiteNumber(usageRaw?.input_tokens),
    output_tokens: finiteNumber(usageRaw?.output_tokens),
    cache_creation_input_tokens: finiteNumber(usageRaw?.cache_creation_input_tokens),
    cache_read_input_tokens: finiteNumber(usageRaw?.cache_read_input_tokens)
  };

  const contextParts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
    .filter((v): v is number => typeof v === 'number');
  const contextTokens = contextParts.length > 0 ? contextParts.reduce((a, b) => a + b, 0) : undefined;

  const discoveredWindow = findNumericKey(latestAssistant, new Set(['context_window_size', 'contextWindowSize', 'context_window_tokens']));
  const configuredDefault = vscode.workspace.getConfiguration('claudeVscodeStatus').get<number>('defaultContextWindowSize', 1_000_000);
  const contextWindowSize = discoveredWindow ?? configuredDefault;

  const modelId = typeof latestAssistant.message?.model === 'string' ? latestAssistant.message.model : undefined;
  return {
    source: 'native',
    sessionId: latestSessionId,
    cwd: latestCwd,
    transcriptPath: file,
    updatedAt: mtimeMs / 1000,
    entrypoint: 'claude-vscode',
    modelId,
    modelName: formatModelName(modelId) ?? modelId ?? 'Claude',
    effort: typeof latestAssistant.effort === 'string' ? latestAssistant.effort : undefined,
    usage,
    contextTokens,
    contextWindowSize,
    contextWindowInferred: discoveredWindow === undefined,
    version: latestVersion
  };
}

async function readTailLines(file: string, maxBytes: number): Promise<string[]> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    }
    return text.split('\n');
  } finally {
    await handle.close();
  }
}

function findNumericKey(value: unknown, keys: Set<string>, depth = 0): number | undefined {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericKey(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (keys.has(key) && typeof record[key] === 'number' && Number.isFinite(record[key])) return record[key] as number;
  }
  for (const child of Object.values(record)) {
    const found = findNumericKey(child, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function encodeClaudeProjectPath(root: string): string {
  const normalized = path.resolve(root);
  return normalized.replace(/[\\/:]/g, '-');
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => normalizePath(f.uri.fsPath));
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

async function readBridgePayloads(): Promise<BridgePayload[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(BRIDGE_SESSIONS_DIR);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const payloads: BridgePayload[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(BRIDGE_SESSIONS_DIR, entry), 'utf8');
      const payload = JSON.parse(raw) as BridgePayload;
      if (payload && typeof payload === 'object') payloads.push(payload);
    } catch {
      // Atomic bridge replacement can race with a poll; next cycle will retry.
    }
  }
  payloads.sort((a, b) => (b.captured_at ?? 0) - (a.captured_at ?? 0));
  return payloads;
}

function bridgeMatchesWorkspace(payload: BridgePayload, roots: string[]): boolean {
  const candidates = [payload.workspace?.project_dir, payload.workspace?.current_dir, payload.cwd, ...(payload.workspace?.added_dirs ?? [])]
    .filter((v): v is string => Boolean(v))
    .map(normalizePath);
  return candidates.some((candidate) => roots.some((root) => pathsOverlap(candidate, root)));
}

async function selectSession() {
  const roots = workspaceRoots();
  const native = await readNativeTranscriptStatuses(roots);
  const bridge = await readBridgePayloads();
  const pinnedId = extensionContext.workspaceState.get<string>(PINNED_SESSION_KEY);

  const items: Array<vscode.QuickPickItem & { sessionId?: string; clear?: boolean }> = [{
    label: '$(sync) Auto-detect most recently active conversation',
    description: pinnedId ? 'Clear pinned conversation' : 'Currently active',
    detail: 'For native Claude VS Code, use the most recently updated matching transcript.',
    clear: true
  }];

  for (const s of native) {
    items.push({
      label: `${s.sessionId === pinnedId ? '$(pin) ' : ''}${s.modelName}${s.effort ? ` (${formatEffort(s.effort)})` : ''}`,
      description: `Native VS Code · ${shortSession(s.sessionId)}`,
      detail: `${s.cwd} · Context ${formatTokenCount(s.contextTokens)}/${formatTokenCount(s.contextWindowSize)} · ${formatAge(s.updatedAt)}`,
      sessionId: s.sessionId
    });
  }

  const nativeIds = new Set(native.map((s) => s.sessionId));
  for (const p of bridge.filter((p) => p.session_id && !nativeIds.has(p.session_id) && (roots.length === 0 || bridgeMatchesWorkspace(p, roots)))) {
    items.push({
      label: `${p.session_id === pinnedId ? '$(pin) ' : ''}${p.model?.display_name ?? formatModelName(p.model?.id) ?? 'Claude'}${p.effort?.level ? ` (${formatEffort(p.effort.level)})` : ''}`,
      description: `CLI/statusLine · ${shortSession(p.session_id)}`,
      detail: `${p.cwd ?? p.workspace?.project_dir ?? 'unknown directory'} · ${formatAge(p.captured_at)}`,
      sessionId: p.session_id
    });
  }

  if (items.length === 1) {
    vscode.window.showInformationMessage('No Claude conversation data found for this workspace yet. Send a prompt first.');
    return;
  }

  const selected = await vscode.window.showQuickPick(items, {
    title: 'Claude Status: Select Conversation for This VS Code Window',
    placeHolder: 'Choose a conversation, or keep automatic most-recent detection',
    matchOnDescription: true,
    matchOnDetail: true
  });
  if (!selected) return;
  await extensionContext.workspaceState.update(PINNED_SESSION_KEY, selected.clear ? undefined : selected.sessionId);
  lastFingerprint = '';
  void refresh();
}

async function clearSessionSelection() {
  await extensionContext.workspaceState.update(PINNED_SESSION_KEY, undefined);
  lastFingerprint = '';
  vscode.window.showInformationMessage('Claude Status conversation pin cleared; auto-detection is active.');
  void refresh();
}

function render(status: DisplayStatus) {
  const showTokens = vscode.workspace.getConfiguration('claudeVscodeStatus').get<boolean>('showTokens', true);
  const segments: string[] = [`${status.modelName}${status.effort ? ` (${formatEffort(status.effort)})` : ''}`];
  let context = `Context ${roundPct(status.contextPct) ?? '–'}%`;
  if (showTokens && typeof status.contextTokens === 'number' && typeof status.contextWindowSize === 'number') {
    context += ` · ${formatTokenCount(status.contextTokens)}/${formatTokenCount(status.contextWindowSize)}`;
  }
  segments.push(context, `5h ${roundPct(status.fiveHour?.used_percentage) ?? '–'}%`, `7d ${roundPct(status.sevenDay?.used_percentage) ?? '–'}%`);
  statusItem.text = segments.join(' │ ');
  statusItem.tooltip = buildTooltip(status);
}

function buildTooltip(status: DisplayStatus): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendMarkdown('**Claude Code Status**\n\n');
  md.appendMarkdown(`Source: **${escapeMd(status.sourceDetail)}**${status.pinned ? ' _(pinned)_' : ' _(auto)_'}  \n`);
  if (status.sessionId) md.appendMarkdown(`Session: **${escapeMd(shortSession(status.sessionId))}**  \n`);
  md.appendMarkdown(`Model: **${escapeMd(status.modelName)}**${status.effort ? ` (${escapeMd(formatEffort(status.effort) ?? status.effort)})` : ''}\n\n`);

  md.appendMarkdown(`Context: **${roundPct(status.contextPct) ?? '–'}%**`);
  if (typeof status.contextTokens === 'number' && typeof status.contextWindowSize === 'number') {
    md.appendMarkdown(` — ${formatNumber(status.contextTokens)} / ${formatNumber(status.contextWindowSize)} tokens`);
    if (status.contextWindowInferred) md.appendMarkdown(' _(window size fallback)_');
  }
  md.appendMarkdown('\n\n');

  if (status.usage) {
    md.appendMarkdown(`Fresh input: ${formatNumber(status.usage.input_tokens)}  \n`);
    md.appendMarkdown(`Cache write: ${formatNumber(status.usage.cache_creation_input_tokens)}  \n`);
    md.appendMarkdown(`Cache read: ${formatNumber(status.usage.cache_read_input_tokens)}  \n`);
    md.appendMarkdown(`Last output: ${formatNumber(status.usage.output_tokens)}  \n\n`);
  }

  md.appendMarkdown(`5h usage: **${roundPct(status.fiveHour?.used_percentage) ?? '–'}%**`);
  const reset5 = formatReset(status.fiveHour?.resets_at);
  if (reset5) md.appendMarkdown(` — resets ${reset5}`);
  md.appendMarkdown('\n\n');
  md.appendMarkdown(`7d usage: **${roundPct(status.sevenDay?.used_percentage) ?? '–'}%**`);
  const reset7 = formatReset(status.sevenDay?.resets_at);
  if (reset7) md.appendMarkdown(` — resets ${reset7}`);

  if (!status.fiveHour && !status.sevenDay) md.appendMarkdown('\n\n_Rate-limit data has not been emitted by the CLI statusLine bridge yet._');
  else if (status.rateCapturedAt) md.appendMarkdown(`\n\nRate limits: ${formatAge(status.rateCapturedAt)}`);

  if (status.cwd) md.appendMarkdown(`  \nDirectory: ${escapeMd(status.cwd)}`);
  if (status.version) md.appendMarkdown(`  \nClaude Code: ${escapeMd(status.version)}`);
  if (status.updatedAt) md.appendMarkdown(`  \nConversation: ${formatAge(status.updatedAt)}`);
  md.appendMarkdown('\n\n_Click to select/pin a different conversation._');
  return md;
}

function roundPct(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

function formatEffort(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatModelName(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  let value = modelId.replace(/^claude-/, '');
  const parts = value.split('-');
  if (parts.length === 0) return modelId;
  const family = parts.shift();
  if (!family) return modelId;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  const versionParts: string[] = [];
  while (parts.length > 0 && /^\d+$/.test(parts[0])) versionParts.push(parts.shift()!);
  let version = '';
  if (versionParts.length === 1) version = versionParts[0];
  else if (versionParts.length >= 2) version = `${versionParts[0]}.${versionParts.slice(1).join('')}`;
  return `${name}${version ? ` ${version}` : ''}`;
}

function formatTokenCount(value: number | undefined): string {
  if (typeof value !== 'number') return '–';
  if (value >= 1_000_000) return `${trimZero((value / 1_000_000).toFixed(1))}m`;
  if (value >= 1_000) return `${trimZero((value / 1_000).toFixed(1))}k`;
  return String(Math.round(value));
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

function formatNumber(value: number | undefined): string {
  return typeof value === 'number' ? Math.round(value).toLocaleString() : '–';
}

function formatReset(epochSeconds: number | undefined): string | undefined {
  if (typeof epochSeconds !== 'number') return undefined;
  const delta = epochSeconds * 1000 - Date.now();
  if (delta <= 0) return 'now';
  const minutes = Math.ceil(delta / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  return `in ${mins}m`;
}

function formatAge(epochSeconds: number | undefined): string {
  if (typeof epochSeconds !== 'number') return 'unknown update time';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (seconds < 10) return 'updated just now';
  if (seconds < 60) return `updated ${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `updated ${days}d ago`;
}

function shortSession(value: string | undefined): string {
  return value ? value.slice(0, 8) : 'unknown';
}

function escapeMd(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}

async function installBridge() {
  await fs.promises.mkdir(BRIDGE_SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const settings = await readSettings();
  const existing = settings.statusLine;
  const ourCommand = bridgeCommand();

  if (existing && !isOurStatusLine(existing)) {
    const choice = await vscode.window.showWarningMessage(
      'Claude Code already has a statusLine configured. Installing this bridge will replace it, but the previous value will be saved and can be restored.',
      { modal: true },
      'Replace and save previous'
    );
    if (choice !== 'Replace and save previous') return;
    await fs.promises.writeFile(PREVIOUS_STATUS_FILE, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  } else if (!existing && !fs.existsSync(PREVIOUS_STATUS_FILE)) {
    await fs.promises.writeFile(PREVIOUS_STATUS_FILE, 'null\n', { mode: 0o600 });
  }

  await writeBridgeFiles();
  const backupPath = `${SETTINGS_FILE}.backup-${timestampForFile()}`;
  if (fs.existsSync(SETTINGS_FILE)) await fs.promises.copyFile(SETTINGS_FILE, backupPath);

  settings.statusLine = { type: 'command', command: ourCommand, refreshInterval: 5 };
  await writeSettings(settings);
  await Promise.allSettled([fs.promises.unlink(LEGACY_EVENTS_FILE)]);
  lastFingerprint = '';
  vscode.window.showInformationMessage('Claude Status usage bridge enabled. Native VS Code conversations are read locally; 5h/7d data will appear when Claude emits rate-limit status data.');
  void refresh();
}

async function removeBridge() {
  const settings = await readSettings();
  if (!isOurStatusLine(settings.statusLine)) {
    vscode.window.showWarningMessage('The active Claude Code statusLine is not owned by this extension, so it was not changed.');
    return;
  }
  let previous: unknown = undefined;
  try { previous = JSON.parse(await fs.promises.readFile(PREVIOUS_STATUS_FILE, 'utf8')); } catch { previous = undefined; }
  if (previous && typeof previous === 'object') settings.statusLine = previous;
  else delete settings.statusLine;
  const backupPath = `${SETTINGS_FILE}.backup-${timestampForFile()}`;
  if (fs.existsSync(SETTINGS_FILE)) await fs.promises.copyFile(SETTINGS_FILE, backupPath);
  await writeSettings(settings);
  await Promise.allSettled([fs.promises.unlink(BRIDGE_SCRIPT_SH), fs.promises.unlink(BRIDGE_SCRIPT_PS1), fs.promises.unlink(PREVIOUS_STATUS_FILE)]);
  vscode.window.showInformationMessage('Claude Status bridge removed. Native transcript display remains available; 5h/7d may be unavailable without another local source.');
}

async function readSettings(): Promise<Record<string, any>> {
  try {
    const raw = await fs.promises.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json root must be an object.');
    return parsed;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Cannot safely parse ${SETTINGS_FILE}. No changes were made. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeSettings(settings: Record<string, any>) {
  await fs.promises.mkdir(CLAUDE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SETTINGS_FILE}.tmp-${process.pid}`;
  await fs.promises.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await fs.promises.rename(tmp, SETTINGS_FILE);
}

function isOurStatusLine(value: any): boolean {
  return Boolean(value && typeof value === 'object' && typeof value.command === 'string' &&
    (value.command.includes('statusline-bridge.sh') || value.command.includes('statusline-bridge.ps1')));
}

function bridgeCommand(): string {
  if (process.platform === 'win32') {
    const escaped = BRIDGE_SCRIPT_PS1.replace(/"/g, '\"');
    return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${escaped}"`;
  }
  return quotePosixPath(BRIDGE_SCRIPT_SH);
}

function quotePosixPath(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writeBridgeFiles() {
  await fs.promises.writeFile(BRIDGE_SCRIPT_SH, bridgeScript(), { mode: 0o700 });
  if (process.platform !== 'win32') await fs.promises.chmod(BRIDGE_SCRIPT_SH, 0o700);
  await fs.promises.writeFile(BRIDGE_SCRIPT_PS1, bridgePowerShell(), { mode: 0o600 });
}

async function offerBridgeSetup() {
  if (extensionContext.globalState.get<boolean>(BRIDGE_PROMPTED_KEY)) return;
  let settings: Record<string, any>;
  try { settings = await readSettings(); } catch { return; }
  if (isOurStatusLine(settings.statusLine)) {
    await extensionContext.globalState.update(BRIDGE_PROMPTED_KEY, true);
    return;
  }
  await extensionContext.globalState.update(BRIDGE_PROMPTED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    'Claude VS Code Status can show model/context immediately. Enable the optional local usage bridge for 5h/7d limits? This updates ~/.claude/settings.json after creating a backup.',
    'Enable 5h/7d',
    'Not now'
  );
  if (choice === 'Enable 5h/7d') await installBridge();
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function bridgePowerShell(): string {
  return `$ErrorActionPreference = "Stop"
$cacheDir = Join-Path $HOME ".claude\\vscode-status"
$sessionsDir = Join-Path $cacheDir "sessions"
New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null
$inputText = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($inputText)) { exit 0 }
$d = $inputText | ConvertFrom-Json
$sid = [string]$d.session_id
if ([string]::IsNullOrWhiteSpace($sid)) { exit 0 }
$safe = $sid -replace '[^A-Za-z0-9._-]', '_'
if ($safe.Length -gt 160) { $safe = $safe.Substring(0, 160) }
$minimal = [ordered]@{
  captured_at = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  session_id = $d.session_id
  session_name = $d.session_name
  cwd = $d.cwd
  version = $d.version
  model = $d.model
  workspace = $d.workspace
  effort = $d.effort
  context_window = $d.context_window
  rate_limits = $d.rate_limits
}
$target = Join-Path $sessionsDir ($safe + ".json")
$tmp = $target + ".tmp." + $PID
$minimal | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $tmp -Encoding UTF8
Move-Item -Force -LiteralPath $tmp -Destination $target
$cutoff = (Get-Date).AddDays(-7)
Get-ChildItem -LiteralPath $sessionsDir -Filter "*.json" -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff } | Remove-Item -Force -ErrorAction SilentlyContinue
`;
}

function bridgeScript(): string {
  return `#!/bin/sh
set -eu
umask 077
CACHE_DIR="$HOME/.claude/vscode-status"
SESSIONS_DIR="$CACHE_DIR/sessions"
mkdir -p "$SESSIONS_DIR"
if command -v python3 >/dev/null 2>&1; then
  INPUT_FILE="$CACHE_DIR/.status-input.$$"
  cat > "$INPUT_FILE"
  python3 - "$SESSIONS_DIR" "$INPUT_FILE" <<'PY'
import json, os, re, sys, time
sessions_dir = sys.argv[1]
input_file = sys.argv[2]
with open(input_file, "r", encoding="utf-8") as f:
    d = json.load(f)
sid = str(d.get("session_id") or "")
if not sid:
    raise SystemExit(0)
safe = re.sub(r"[^A-Za-z0-9._-]", "_", sid)[:160]
minimal = {
    "captured_at": int(time.time()),
    "session_id": sid,
    "session_name": d.get("session_name"),
    "cwd": d.get("cwd"),
    "version": d.get("version"),
    "model": d.get("model"),
    "workspace": d.get("workspace"),
    "effort": d.get("effort"),
    "context_window": d.get("context_window"),
    "rate_limits": d.get("rate_limits"),
}
target = os.path.join(sessions_dir, safe + ".json")
tmp = target + ".tmp.%d" % os.getpid()
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(minimal, f, separators=(",", ":"))
    f.write("\\n")
os.chmod(tmp, 0o600)
os.replace(tmp, target)
cutoff = time.time() - 7 * 24 * 60 * 60
try:
    for name in os.listdir(sessions_dir):
        if name.endswith(".json"):
            p = os.path.join(sessions_dir, name)
            try:
                if os.path.getmtime(p) < cutoff:
                    os.unlink(p)
            except OSError:
                pass
except OSError:
    pass
PY
  rm -f "$INPUT_FILE"
elif command -v jq >/dev/null 2>&1; then
  INPUT=$(cat)
  SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
  [ -n "$SID" ] || exit 0
  SAFE=$(printf '%s' "$SID" | tr -c 'A-Za-z0-9._-' '_')
  TARGET="$SESSIONS_DIR/$SAFE.json"
  TMP="$TARGET.tmp.$$"
  printf '%s' "$INPUT" | jq -c --argjson t "$(date +%s)" '{captured_at:$t,session_id,session_name,cwd,version,model,workspace,effort,context_window,rate_limits}' > "$TMP"
  chmod 600 "$TMP"
  mv "$TMP" "$TARGET"
else
  exit 0
fi
printf ''
`;
}

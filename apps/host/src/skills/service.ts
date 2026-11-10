import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  skillCatalogSchema,
  skillLimits,
  type Session,
  type SkillEntry,
  type SkillReference,
} from '@nesvo/contracts';
import { inspectCodexSkills } from '../providers/codex';
import { inspectLocalSkillLibrary } from './library';
import {
  readSkillSnapshot,
  skillCompatibility,
  type SkillSnapshot,
} from './portable';

const pathKey = (path: string) =>
  process.platform === 'win32' ? path.toLowerCase() : path;

async function withSignal<T>(operation: Promise<T>, signal: AbortSignal) {
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () =>
          reject(new Error('Skill inspection was stopped or timed out.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function parallel<T>(items: T[], inspect: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) await inspect(items[next++]!);
    }),
  );
}

type SkillTarget = Pick<Session, 'provider' | 'directory'> & { id?: string };

async function loadLibrary(session: SkillTarget, signal: AbortSignal) {
  signal.throwIfAborted();
  const directory = resolve(session.directory);
  const info = await withSignal(lstat(directory), signal);
  const canonical = await withSignal(realpath(directory), signal);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    pathKey(directory) !== pathKey(canonical)
  )
    throw new Error('The session directory changed or is unavailable.');
  const local = await inspectLocalSkillLibrary(directory, signal);
  signal.throwIfAborted();
  const roots = [
    ...new Set(
      local.skills
        .filter(
          skill =>
            skill.kind === 'skill' && skill.enabled !== false && skill.path,
        )
        .map(skill => dirname(skill.path!)),
    ),
  ];
  const native = await inspectCodexSkills(directory, signal, roots);
  signal.throwIfAborted();
  const issues = [...local.issues, ...native.issues];
  const entries = new Map(
    local.skills.map(skill => [pathKey(skill.path!), { ...skill }]),
  );
  const nativeByPath = new Map<string, SkillEntry>();
  const inspectionSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const nativePaths = new Map<SkillEntry, string>();
  await parallel(native.skills, async skill => {
    if (!skill.path) return;
    try {
      nativePaths.set(
        skill,
        await withSignal(realpath(skill.path), inspectionSignal),
      );
    } catch {
      nativePaths.set(skill, skill.path);
    }
  });
  let truncated = local.truncated || native.truncated;
  for (const skill of native.skills) {
    const path = nativePaths.get(skill);
    if (!path) continue;
    const key = pathKey(path);
    const previous = nativeByPath.get(key);
    if (!previous || skill.enabled === false || pathKey(skill.path!) === key)
      nativeByPath.set(key, previous?.enabled === false ? previous : skill);
    const existing = entries.get(key);
    if (existing) {
      existing.enabled =
        existing.enabled === false || skill.enabled === false
          ? false
          : skill.enabled;
    } else if (entries.size < skillLimits.entries) {
      entries.set(key, { ...skill, path, origins: ['Codex'] });
    } else truncated = true;
  }
  const nativeById = new Map<string, SkillEntry>();
  const snapshots = new Map<string, SkillSnapshot>();
  await parallel([...entries.values()], async skill => {
    const nativeSkill = nativeByPath.get(pathKey(skill.path!));
    if (nativeSkill) nativeById.set(skill.id, nativeSkill);
    const nativeAvailable =
      session.provider === 'Codex' && nativeSkill?.enabled === true;
    const foreign = skill.origins?.some(origin => origin !== 'Codex');
    skill.invocation = 'blocked';
    skill.invocationReason = null;
    if (skill.enabled === false) {
      skill.invocationReason =
        skill.detail ||
        'Disabled in a discovered source or provider configuration.';
      return;
    }
    if (skill.kind !== 'skill') {
      skill.invocationReason =
        'Legacy commands require provider-specific command handling.';
      return;
    }
    if (skill.userInvocable === false) {
      skill.invocationReason = 'This skill disables manual invocation.';
      return;
    }
    if (session.provider === 'Codex' && !nativeAvailable) {
      skill.invocationReason =
        'This source is not available in the current native Codex catalog. Refresh or update Codex.';
      return;
    }
    try {
      const snapshot = await readSkillSnapshot(skill.path!, inspectionSignal);
      skill.contentHash = snapshot.contentHash;
      snapshots.set(skill.id, snapshot);
      const reason =
        session.provider === 'Claude Code' || foreign
          ? skillCompatibility(snapshot, session.provider)
          : null;
      if (reason) {
        skill.invocationReason = reason;
        return;
      }
      skill.invocation = nativeAvailable ? 'native' : 'instructions';
    } catch (error) {
      skill.invocationReason =
        error instanceof Error
          ? error.message.slice(0, skillLimits.detail)
          : 'The skill file could not be verified.';
    }
  });
  signal.throwIfAborted();
  if (inspectionSignal.aborted)
    issues.push({
      path: null,
      message:
        'Some compatibility checks reached their time limit. Refresh to check again.',
    });
  if (issues.length > skillLimits.issues) truncated = true;
  const skills = [...entries.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.path!.localeCompare(right.path!),
  );
  const catalog = skillCatalogSchema.parse({
    ...(session.id ? { sessionId: session.id } : { directory }),
    provider: session.provider,
    method: 'library',
    status: issues.length || truncated ? 'partial' : 'ready',
    skills,
    issues: issues.slice(0, skillLimits.issues),
    truncated,
    invocationSupported: skills.some(skill => skill.invocation !== 'blocked'),
    checkedAt: new Date().toISOString(),
  });
  return {
    catalog,
    nativeById,
    snapshots,
    rootsSupported: native.extraRootsSupported,
  };
}

export async function discoverSessionSkills(
  session: Session,
  signal: AbortSignal,
) {
  return (await loadLibrary(session, signal)).catalog;
}

export async function discoverDirectorySkills(
  provider: Session['provider'],
  directory: string,
  signal: AbortSignal,
) {
  return (await loadLibrary({ provider, directory }, signal)).catalog;
}

export async function resolveSessionSkill(
  session: Session,
  skillId: string,
  expectedHash: string | undefined,
  signal: AbortSignal,
) {
  const { catalog, nativeById, snapshots, rootsSupported } = await loadLibrary(
    session,
    signal,
  );
  const entry = catalog.skills.find(skill => skill.id === skillId);
  if (!entry)
    throw new Error(
      'The selected skill is no longer available. Refresh the library and select it again.',
    );
  if (entry.invocation === 'blocked' || !entry.path)
    throw new Error(
      entry.invocationReason ||
        'The selected skill is not compatible with this connection.',
    );
  if (entry.contentHash && entry.contentHash !== expectedHash)
    throw new Error(
      'The selected skill changed or its snapshot is missing. Refresh the library and select it again.',
    );
  if (expectedHash && expectedHash !== entry.contentHash)
    throw new Error(
      'The selected skill could not be verified against its selected snapshot. Refresh the library.',
    );
  const reference: SkillReference = {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    source: entry.source,
    origins: entry.origins,
    delivery: entry.invocation === 'native' ? 'native' : 'instructions',
    ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
  };
  const snapshot = snapshots.get(entry.id);
  if (reference.delivery === 'instructions' && !snapshot)
    throw new Error('The selected instruction snapshot is unavailable.');
  const native = nativeById.get(entry.id);
  if (reference.delivery === 'native' && !native?.path)
    throw new Error(
      'The selected skill is absent from the native provider catalog.',
    );
  return { reference, snapshot, native, rootsSupported };
}

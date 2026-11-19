import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function agentDeckImportFixture(root, codexRoot, t3) {
  const sqlite = join(root, 'profiles', 'work');
  const legacy = join(root, 'profiles', 'personal');
  const rollouts = join(codexRoot, 'sessions', '2026', '11', '19');
  await Promise.all(
    [sqlite, legacy, rollouts].map(path => mkdir(path, { recursive: true })),
  );
  const sqlitePath = join(sqlite, 'state.db');
  const legacyPath = join(legacy, 'sessions.json');
  const nativeId = randomUUID();
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`
      CREATE TABLE instances (id TEXT PRIMARY KEY, title TEXT, tool TEXT, status TEXT,
        group_path TEXT, sort_order INTEGER, archived_at INTEGER, created_at INTEGER, last_accessed INTEGER,
        project_path TEXT, worktree_path TEXT, worktree_repo TEXT, worktree_branch TEXT, tool_data TEXT);
      CREATE TABLE groups (path TEXT PRIMARY KEY, name TEXT, sort_order INTEGER, default_path TEXT);
    `);
    const group = db.prepare('INSERT INTO groups VALUES (?, ?, ?, ?)');
    group.run('engineering', 'Engineering', 0, t3.workspace);
    group.run('engineering/platform', 'Platform', 0, '');
    group.run(
      'engineering/platform/releases/november',
      'November',
      0,
      t3.worktree,
    );
    group.run('empty', 'Empty group', 1, t3.workspace);
    const instance = db.prepare(`
      INSERT INTO instances VALUES (?, ?, 'claude', 'idle', 'engineering/platform/releases/november',
        0, 1794992400, 1794819600, 1794906000, ?, ?, ?, 'fixture/release', ?)
    `);
    const add = (id, title, extra = {}) =>
      instance.run(
        id,
        title,
        t3.workspace,
        t3.worktree,
        t3.workspace,
        JSON.stringify({ claude_session_id: t3.nativeId, ...extra }),
      );
    add('release', 'Agent Deck release notes');
    add('ssh', 'Remote agent', { ssh_host: 'fixture-host' });
    add('guessed', 'Guessed conversation', {
      claude_session_id_unverified: true,
    });
  } finally {
    db.close();
  }
  await writeFile(
    legacyPath,
    JSON.stringify({
      instances: [
        {
          id: 'migration',
          title: 'Database migration',
          project_path: t3.workspace,
          group_path: '',
          order: 3,
          tool: 'codex',
          status: 'idle',
          codex_session_id: nativeId,
          created_at: t3.createdAt,
        },
      ],
      groups: [
        {
          path: 'misc',
          name: 'Personal notes',
          order: 0,
          default_path: t3.workspace,
        },
      ],
    }),
  );
  const path = join(
    rollouts,
    'rollout-2026-11-19T12-00-00-' + nativeId + '.jsonl',
  );
  const metadata = {
    type: 'session_meta',
    timestamp: t3.createdAt,
    payload: { id: nativeId, cwd: await realpath(t3.workspace) },
  };
  const prompt = {
    type: 'response_item',
    timestamp: t3.createdAt,
    payload: {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Review the example database schema.' },
      ],
    },
  };
  await writeFile(
    path,
    [metadata, prompt].map(row => JSON.stringify(row)).join('\n') + '\n',
  );
  return { sqlitePath, legacyPath, path, nativeId };
}

export async function t3ImportFixture(root, claudeRoot) {
  const workspace = join(root, 'workspace');
  const worktree = join(root, 'worktree');
  const userdata = join(root, 'userdata');
  const transcripts = join(claudeRoot, 'projects', 'fixture');
  await Promise.all(
    [workspace, worktree, userdata, transcripts].map(path =>
      mkdir(path, { recursive: true }),
    ),
  );
  const path = join(userdata, 'statev2.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT, workspace_root TEXT, archived_at TEXT, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, active_provider_thread_id TEXT,
      archived_at TEXT, deleted_at TEXT, created_at TEXT, updated_at TEXT, payload_json TEXT
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, status TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
    PRAGMA wal_checkpoint(TRUNCATE);
  `);
  const nativeId = randomUUID();
  const duplicateId = randomUUID();
  const removedId = randomUUID();
  const archivedAt = '2026-11-18T09:00:00.000Z';
  const createdAt = '2026-11-16T08:00:00.000Z';
  const updatedAt = '2026-11-17T08:00:00.000Z';
  db.prepare(
    "INSERT INTO projection_projects VALUES ('release', 'Release workspace', ?, ?, NULL)",
  ).run(workspace, archivedAt);
  const add = (id, title, native, path, archived, state) => {
    db.prepare(
      "INSERT INTO orchestration_v2_projection_threads VALUES (?, 'release', ?, ?, ?, NULL, ?, ?, ?)",
    ).run(
      id,
      title,
      'binding-' + id,
      archived,
      createdAt,
      updatedAt,
      JSON.stringify({ worktreePath: path, branch: 'fixture/release' }),
    );
    db.prepare(
      "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, 'claudeAgent', 'idle', ?)",
    ).run(
      'binding-' + id,
      id,
      JSON.stringify({
        nativeThreadRef: {
          driver: 'claudeAgent',
          strength: 'strong',
          nativeId: native,
        },
      }),
    );
    db.prepare(
      'INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)',
    ).run('run-' + id, id, state);
  };
  add('archived', 'Release notes', nativeId, worktree, archivedAt, 'completed');
  add(
    'duplicate',
    'T3 copy of API review',
    duplicateId,
    null,
    null,
    'completed',
  );
  const removedFolder = join(root, 'removed-with-history');
  add(
    'removed-worktree',
    'Removed worktree with history',
    removedId,
    removedFolder,
    null,
    'completed',
  );
  add(
    'missing-folder',
    'Old worktree',
    randomUUID(),
    join(root, 'removed'),
    null,
    'completed',
  );
  add(
    'missing-transcript',
    'Test results',
    randomUUID(),
    null,
    null,
    'completed',
  );
  add('running', 'Build in progress', nativeId, worktree, null, 'waiting');
  const makeTranscript = async (id, folder, body, { removed = false } = {}) => {
    const file = join(transcripts, id + '.jsonl');
    await writeFile(
      file,
      JSON.stringify({
        type: 'user',
        sessionId: id,
        cwd: removed ? folder : await realpath(folder),
        timestamp: createdAt,
        message: { role: 'user', content: body },
      }) + '\n',
    );
    return file;
  };
  const transcript = await makeTranscript(
    nativeId,
    worktree,
    'Draft release notes for the example project.',
  );
  const duplicateTranscript = await makeTranscript(
    duplicateId,
    workspace,
    'Review the example API.',
  );
  const removedTranscript = await makeTranscript(
    removedId,
    removedFolder,
    'Continue the example from the project.',
    { removed: true },
  );
  return {
    db,
    path,
    workspace,
    worktree,
    transcript,
    duplicateTranscript,
    removedTranscript,
    removedId,
    nativeId,
    duplicateId,
    archivedAt,
    createdAt,
  };
}

import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function t3ImportFixture(root, claudeRoot) {
  const workspace = join(root, 'workspace');
  const worktree = join(root, 'worktree');
  const userdata = join(root, 'userdata');
  const transcripts = join(claudeRoot, 'projects', 'fixture');
  await Promise.all([workspace, worktree, userdata, transcripts].map(path => mkdir(path, { recursive: true })));
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
  const archivedAt = '2026-11-18T09:00:00.000Z';
  const createdAt = '2026-11-16T08:00:00.000Z';
  const updatedAt = '2026-11-17T08:00:00.000Z';
  db.prepare("INSERT INTO projection_projects VALUES ('release', 'Release workspace', ?, ?, NULL)").run(workspace, archivedAt);
  const add = (id, title, native, path, archived, state) => {
    db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, 'release', ?, ?, ?, NULL, ?, ?, ?)").run(
      id, title, 'binding-' + id, archived, createdAt, updatedAt,
      JSON.stringify({ worktreePath: path, branch: 'fixture/release' }),
    );
    db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, 'claudeAgent', 'idle', ?)").run(
      'binding-' + id, id, JSON.stringify({ nativeThreadRef: { driver: 'claudeAgent', strength: 'strong', nativeId: native } }),
    );
    db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?)').run('run-' + id, id, state);
  };
  add('archived', 'Release notes', nativeId, worktree, archivedAt, 'completed');
  add('duplicate', 'T3 copy of API review', duplicateId, null, null, 'completed');
  add('missing-folder', 'Old worktree', randomUUID(), join(root, 'removed'), null, 'completed');
  add('missing-transcript', 'Test results', randomUUID(), null, null, 'completed');
  add('running', 'Build in progress', nativeId, worktree, null, 'waiting');
  const makeTranscript = async (id, folder, body) => {
    const file = join(transcripts, id + '.jsonl');
    await writeFile(file, JSON.stringify({
      type: 'user', sessionId: id, cwd: await realpath(folder), timestamp: createdAt,
      message: { role: 'user', content: body },
    }) + '\n');
    return file;
  };
  const transcript = await makeTranscript(nativeId, worktree, 'Draft release notes for the example project.');
  const duplicateTranscript = await makeTranscript(duplicateId, workspace, 'Review the example API.');
  return { db, path, workspace, worktree, transcript, duplicateTranscript, nativeId, duplicateId, archivedAt, createdAt };
}

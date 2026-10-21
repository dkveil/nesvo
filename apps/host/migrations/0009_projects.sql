CREATE TABLE projects(root TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,default_branch TEXT,pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN(0,1)),default_layout TEXT,first_seen_ms INTEGER NOT NULL,last_activity_ms INTEGER NOT NULL);
CREATE INDEX projects_order ON projects(pinned DESC,last_activity_ms DESC);
CREATE TABLE project_folders(root TEXT NOT NULL REFERENCES projects(root) ON DELETE CASCADE,folder TEXT NOT NULL,launches INTEGER NOT NULL,last_launch_ms INTEGER NOT NULL,PRIMARY KEY(root,folder));

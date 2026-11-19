import { useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Folder,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Settings2,
  Square,
  Workflow,
} from 'lucide-react';
import { DiffStat, FileGlyph } from '@/entities/file-change';
import { StatusIcon } from '@/entities/status';
import { CountBadge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Disclosure, NativeDisclosure } from '@/shared/ui/disclosure';
import { MiddleTruncatedText } from '@/shared/ui/middle-truncated-text';
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import { IconButton } from '@/shared/ui/icon-button';
import { ListRow } from '@/shared/ui/list-row';
import { NavItem, NavList } from '@/shared/ui/nav-list';
import { SectionLabel } from '@/shared/ui/section-label';
import { StatusDot } from '@/shared/ui/status-dot';
import { TabPanel, Tabs } from '@/shared/ui/tabs';
import { CatalogSection, Specimen, StateCaption } from './specimen';

function TabSpecimens() {
  const [tab, setTab] = useState<'summary' | 'timeline' | 'code'>('summary');
  const [files, setFiles] = useState(['app.tsx', 'styles.css', 'readme.md']);
  const [file, setFile] = useState('app.tsx');
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <StateCaption label="underline · sliding indicator">
        <div className="w-full rounded-control border bg-card">
          <Tabs
            label="Sample sections"
            idPrefix="catalog-tabs"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'summary', label: 'Summary' },
              { value: 'timeline', label: 'Timeline', count: 12 },
              { value: 'code', label: 'Code', count: 4 },
            ]}
          />
          <TabPanel
            idPrefix="catalog-tabs"
            value={tab}
            className="px-3 py-3 text-xs text-muted-foreground"
          >
            Sample {tab} panel.
          </TabPanel>
        </div>
      </StateCaption>
      <StateCaption label="editor · closable">
        <div className="w-full overflow-hidden rounded-control border">
          <Tabs
            label="Open files"
            idPrefix="catalog-editor-tabs"
            variant="editor"
            value={file}
            onChange={setFile}
            onClose={value => {
              const next = files.filter(entry => entry !== value);
              setFiles(next.length ? next : ['app.tsx']);
              if (value === file) setFile(next[0] ?? 'app.tsx');
            }}
            options={files.map(name => ({
              value: name,
              label: name,
              icon: <FileGlyph name={name} />,
              closable: true,
            }))}
          />
          <TabPanel
            idPrefix="catalog-editor-tabs"
            value={file}
            className="bg-background px-3 py-3 font-mono text-xs text-muted-foreground"
          >
            {file}
          </TabPanel>
        </div>
      </StateCaption>
    </div>
  );
}

function NavSpecimens() {
  const [page, setPage] = useState('general');
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <StateCaption label="default tone · sm">
        <NavList
          label="Sample settings"
          className="w-52 rounded-control bg-card p-2"
        >
          <NavItem
            icon={<Settings2 />}
            selected={page === 'general'}
            onClick={() => setPage('general')}
          >
            General
          </NavItem>
          <NavItem
            icon={<Folder />}
            selected={page === 'folders'}
            onClick={() => setPage('folders')}
          >
            Folders
          </NavItem>
          <NavItem icon={<Archive />} data-preview-hover="">
            Hover
          </NavItem>
          <NavItem icon={<Archive />} data-preview-focus="">
            Focus
          </NavItem>
          <NavItem icon={<Archive />} disabled>
            Disabled
          </NavItem>
        </NavList>
      </StateCaption>
      <StateCaption label="sidebar tone · md">
        <NavList
          label="Sample sidebar"
          className="w-52 rounded-control bg-sidebar p-2"
        >
          <NavItem tone="sidebar" size="md" icon={<MessageSquare />}>
            Sessions
          </NavItem>
          <NavItem
            tone="sidebar"
            size="md"
            icon={<Inbox />}
            selected
            trailing={<CountBadge count={3} />}
          >
            Inbox
          </NavItem>
          <NavItem
            tone="sidebar"
            size="md"
            icon={<Workflow />}
            data-preview-hover=""
          >
            Workflows
          </NavItem>
        </NavList>
      </StateCaption>
    </div>
  );
}

function RowSpecimens() {
  const [selected, setSelected] = useState('two');
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <StateCaption label="compact 28px · hover · selected · disabled · actions">
        <div className="w-full space-y-0.5 rounded-control border bg-card p-1">
          {(
            [
              ['one', 'Sample session one'],
              ['two', 'Sample session two'],
              ['three', 'Sample session three'],
            ] as const
          ).map(([id, title]) => (
            <ListRow
              key={id}
              leading={<MessageSquare />}
              title={title}
              trailing="2m"
              selected={selected === id}
              onClick={() => setSelected(id)}
              actions={
                <IconButton label="Row actions" size={20}>
                  <MoreHorizontal />
                </IconButton>
              }
            />
          ))}
          <ListRow
            leading={<Pin />}
            title="Hover preview"
            trailing="1h"
            onClick={() => undefined}
            data-preview-hover=""
          />
          <ListRow
            leading={<Archive />}
            title="Disabled row"
            disabled
            onClick={() => undefined}
          />
        </div>
      </StateCaption>
      <StateCaption label="tree 22px · drop indicators">
        <div className="w-full rounded-control border bg-card p-1">
          <ListRow
            density="tree"
            leading={<ChevronRight />}
            title="src"
            onClick={() => undefined}
          />
          <ListRow
            density="tree"
            level={1}
            leading={<FileGlyph name="app.tsx" />}
            title="app.tsx"
            onClick={() => undefined}
            dropIndicator="before"
          />
          <ListRow
            density="tree"
            level={1}
            leading={<FileGlyph name="styles.css" />}
            title="styles.css"
            selected
            onClick={() => undefined}
          />
          <ListRow
            density="tree"
            level={1}
            leading={<Folder />}
            title="shared (drop inside)"
            onClick={() => undefined}
            dropIndicator="inside"
          />
          <ListRow
            density="tree"
            level={2}
            leading={<FileGlyph name="package.json" />}
            title="package.json"
            onClick={() => undefined}
          />
        </div>
      </StateCaption>
      <StateCaption label="two-line">
        <div className="w-full rounded-control border bg-card p-1">
          <ListRow
            density="two-line"
            leading={<StatusIcon status="success" className="size-3.5" />}
            title="Sample pull request title"
            description="sample/repository #42 · updated 2h ago"
            trailing={<DiffStat additions={128} deletions={14} />}
            onClick={() => undefined}
          />
          <ListRow
            density="two-line"
            leading={<StatusIcon status="pending" className="size-3.5" />}
            title="Another sample change"
            description="sample/repository #41 · draft"
            trailing={<DiffStat additions={6} deletions={2} />}
            selected
            onClick={() => undefined}
          />
        </div>
      </StateCaption>
      <StateCaption label="info-panel · compact · visible open action">
        <div className="w-full rounded-control border border-info-panel-border bg-info-panel p-1">
          <ListRow
            leading={<StatusDot tone="info" variant="spinner" size="md" />}
            title="Sample worker"
            trailing={<span>4m 12s</span>}
            actionsPlacement="visible"
            actions={
              <IconButton size={24} label="Open sample worker">
                <ChevronRight />
              </IconButton>
            }
            onClick={() => undefined}
          />
        </div>
      </StateCaption>
      <StateCaption label="info-panel · two-line sm · actions on hover">
        <div className="w-full rounded-control border border-info-panel-border bg-info-panel p-1">
          <ListRow
            density="two-line"
            size="sm"
            leading={<StatusDot tone="warning" size="md" />}
            title="Sample worker"
            meta={
              <>
                <span className="text-warning-foreground">Needs approval</span>
                <span>12s</span>
              </>
            }
            description="Sample model"
            actions={
              <IconButton size={24} tone="danger" label="Stop sample worker">
                <Square className="fill-current" />
              </IconButton>
            }
            onClick={() => undefined}
          />
        </div>
      </StateCaption>
      <StateCaption label="sidebar tone · sm · heading · meta · overlay actions">
        <div className="w-full space-y-0.5 rounded-control bg-sidebar p-1">
          <ListRow
            tone="sidebar"
            size="sm"
            heading
            leading={<ChevronDown />}
            title="Sample group"
            trailing="3"
            actionsPlacement="overlay"
            actions={
              <IconButton label="Group actions" size={20} tone="sidebar">
                <MoreHorizontal />
              </IconButton>
            }
            onClick={() => undefined}
          />
          {(
            [
              ['one', 'Sample session one', 'now', 'info', 'spinner'],
              ['two', 'Sample session two', '2h', 'success', 'solid'],
              [
                'three',
                'Sample session three',
                'Needs you',
                'warning',
                'solid',
              ],
            ] as const
          ).map(([id, title, time, tone, variant]) => (
            <ListRow
              key={id}
              tone="sidebar"
              density="two-line"
              size="sm"
              level={1}
              leading={<StatusDot size="md" tone={tone} variant={variant} />}
              title={title}
              meta={
                tone === 'warning' ? (
                  <span className="font-medium text-warning-foreground">
                    {time}
                  </span>
                ) : (
                  time
                )
              }
              description="sample-folder · main"
              actionsPlacement="overlay"
              actions={
                <IconButton label="Session actions" size={20} tone="sidebar">
                  <MoreHorizontal />
                </IconButton>
              }
              selected={id === 'two'}
              onClick={() => undefined}
            />
          ))}
          <ListRow
            tone="sidebar"
            density="tree"
            size="sm"
            level={2}
            leading={<ChevronRight />}
            title="Tree row in the sidebar"
            onClick={() => undefined}
          />
        </div>
      </StateCaption>
      <StateCaption label="grid (static)">
        <div className="w-full rounded-control border bg-card p-1">
          {(
            [
              ['Today', '4', '0:12'],
              ['This week', '19', '1:47'],
            ] as const
          ).map(([period, runs, time]) => (
            <ListRow
              key={period}
              density="grid"
              columns="minmax(0,1fr) 4rem 4rem"
            >
              <span className="truncate">{period}</span>
              <span className="text-right text-muted-foreground tabular-nums">
                {runs}
              </span>
              <span className="text-right text-muted-foreground tabular-nums">
                {time}
              </span>
            </ListRow>
          ))}
        </div>
      </StateCaption>
      <StateCaption label="block · multi-line with decisions">
        <div className="w-full rounded-control border bg-card p-1">
          <ListRow density="block" columns="minmax(0,1fr) auto">
            <div className="min-w-0 space-y-1">
              <Button variant="link" size="inline" className="text-foreground">
                Sample session
              </Button>
              <p className="line-clamp-2 text-muted-foreground">
                A wrapped summary of the request that needs a decision.
              </p>
              <p className="text-2xs text-muted-foreground">
                Result · v2 · Pending
              </p>
            </div>
            <div className="flex items-center gap-1.5 self-center">
              <Button variant="secondary">Accept</Button>
              <Button variant="ghost">Decline</Button>
            </div>
          </ListRow>
        </div>
      </StateCaption>
    </div>
  );
}

export function NavigationSection() {
  return (
    <CatalogSection
      id="navigation"
      title="Navigation and lists"
      description="Selected state is always data-selected on the styled element, with the ARIA attribute that fits the role: aria-current for navigation, aria-selected for tabs and options, aria-pressed for toggles."
    >
      <Specimen title="Tabs" source="shared/ui/tabs.tsx">
        <TabSpecimens />
      </Specimen>
      <Specimen title="NavList and NavItem" source="shared/ui/nav-list.tsx">
        <NavSpecimens />
      </Specimen>
      <Specimen title="ListRow" source="shared/ui/list-row.tsx">
        <RowSpecimens />
      </Specimen>
      <Specimen
        title="SectionLabel and Disclosure"
        source="section-label.tsx · disclosure.tsx"
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-control border bg-card p-1">
            <SectionLabel
              count={2}
              action={
                <IconButton label="Section actions" size={20}>
                  <MoreHorizontal />
                </IconButton>
              }
            >
              Pinned
            </SectionLabel>
            <ListRow
              leading={<Pin />}
              title="Sample pinned session"
              onClick={() => undefined}
            />
            <ListRow
              leading={<Pin />}
              title="Another pinned session"
              onClick={() => undefined}
            />
          </div>
          <div className="space-y-2">
            <SettingsSection title="Flat settings section">
              <SettingsRow
                title="Project folder"
                description={
                  <MiddleTruncatedText
                    className="max-w-48"
                    value="C:/Users/example/development/projects/nesvo/workspaces"
                  />
                }
              />
            </SettingsSection>
            <Disclosure title="Sample details" meta="3" defaultOpen>
              The disclosure body uses muted 12px text and indents under the
              chevron.
            </Disclosure>
            <Disclosure title="Muted disclosure" triggerTone="muted" meta="12">
              Hidden sample content.
            </Disclosure>
            <NativeDisclosure
              title="Native disclosure with description"
              description="A second muted line previews the collapsed content."
              meta="Pending"
            >
              Rendered with details and summary, so the content stays in the
              document and the open attribute is preserved.
            </NativeDisclosure>
          </div>
        </div>
      </Specimen>
    </CatalogSection>
  );
}

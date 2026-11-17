import { useState } from 'react';
import {
  Bot,
  ChevronDown,
  Files,
  Folder,
  GitPullRequest,
  Maximize2,
  RefreshCw,
  WrapText,
  X,
} from 'lucide-react';
import { Button } from '@/shared/ui/button';
import { Chip } from '@/shared/ui/chip';
import { CodeBlock } from '@/shared/ui/code-block';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import { IconButton } from '@/shared/ui/icon-button';
import { KeyValueList } from '@/shared/ui/key-value-list';
import {
  Panel,
  PanelAction,
  PanelBody,
  PanelHeader,
  PanelSearch,
  Toolbar,
  ToolbarSeparator,
  ToolbarSpacer,
} from '@/shared/ui/panel';
import { ListRow } from '@/shared/ui/list-row';
import { FileGlyph } from '@/entities/file-change';
import { CatalogSection, Specimen, StateCaption } from './specimen';

const SAMPLE_CODE = `export function greet(name: string) {
  return \`Hello, \${name}\`;
}`;

function Composers() {
  const [draft, setDraft] = useState('');
  const [comment, setComment] = useState('Sample review comment');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <StateCaption label="default · empty (send idle)">
        <form className="w-full" onSubmit={event => event.preventDefault()}>
          <Composer>
            <ComposerInput
              aria-label="Sample message"
              placeholder="Ask for a change"
              value={draft}
              onChange={event => setDraft(event.target.value)}
            />
            <ComposerToolbar
              start={
                <>
                  <Chip icon={<Folder />}>
                    <span>sample-project</span>
                  </Chip>
                  <Chip icon={<Bot />}>
                    <span>Sample model</span>
                    <ChevronDown />
                  </Chip>
                </>
              }
              end={<ComposerSend disabled={!draft.trim()} />}
            />
          </Composer>
        </form>
      </StateCaption>
      <StateCaption label="compact · comment box">
        <form className="w-full" onSubmit={event => event.preventDefault()}>
          <Composer variant="compact">
            <ComposerInput
              aria-label="Sample comment"
              value={comment}
              onChange={event => setComment(event.target.value)}
            />
            <ComposerToolbar
              start="Ctrl Enter to send"
              end={
                <>
                  <Button variant="ghost" size="xs">
                    Cancel
                  </Button>
                  <ComposerSend label="Comment" disabled={!comment.trim()} />
                </>
              }
            />
          </Composer>
        </form>
      </StateCaption>
      <StateCaption label="pending">
        <div className="w-full">
          <Composer variant="compact">
            <ComposerInput
              aria-label="Pending sample"
              defaultValue="Sending a sample"
              disabled
            />
            <ComposerToolbar end={<ComposerSend pending disabled />} />
          </Composer>
        </div>
      </StateCaption>
    </div>
  );
}

export function SurfacesSection() {
  return (
    <CatalogSection
      id="surfaces"
      title="Panels and surfaces"
      description="Docked panels use PanelHeader (h-10) and an optional Toolbar (h-9). Composer is the only glass shell for writing to an agent or a review."
    >
      <Specimen
        title="Panel, PanelHeader and Toolbar"
        source="shared/ui/panel.tsx"
      >
        <Panel className="h-80 w-full max-w-md overflow-hidden rounded-control border">
          <PanelHeader icon={Files} title="Files" meta="sample-project">
            <PanelAction aria-label="Refresh">
              <RefreshCw />
            </PanelAction>
            <PanelAction aria-label="Expand">
              <Maximize2 />
            </PanelAction>
            <PanelAction aria-label="Close">
              <X />
            </PanelAction>
          </PanelHeader>
          <Toolbar label="File tools">
            <PanelSearch
              aria-label="Search files"
              placeholder="Search files"
              className="flex-1"
            />
            <ToolbarSeparator />
            <IconButton label="Wrap lines" pressed>
              <WrapText />
            </IconButton>
          </Toolbar>
          <PanelBody className="p-1">
            {['app.tsx', 'styles.css', 'package.json', 'readme.md'].map(
              (name, index) => (
                <ListRow
                  key={name}
                  density="tree"
                  leading={<FileGlyph name={name} />}
                  title={name}
                  selected={index === 1}
                  onClick={() => undefined}
                />
              ),
            )}
          </PanelBody>
          <Toolbar label="Footer" bordered={false} className="border-t">
            <span className="text-2xs text-muted-foreground">
              4 sample files
            </span>
            <ToolbarSpacer />
            <Button variant="ghost" size="xs">
              Collapse all
            </Button>
          </Toolbar>
        </Panel>
        <Panel className="w-full max-w-md overflow-hidden rounded-control border">
          <PanelHeader
            leading={
              <GitPullRequest
                aria-hidden="true"
                className="size-3.5 shrink-0 text-success-foreground"
              />
            }
            title={
              <>
                <span className="font-normal text-muted-foreground">
                  sample/a-long-repository-name
                </span>{' '}
                #42
              </>
            }
          >
            <PanelAction aria-label="Close">
              <X />
            </PanelAction>
          </PanelHeader>
        </Panel>
      </Specimen>
      <Specimen title="Composer" source="shared/ui/composer.tsx">
        <Composers />
      </Specimen>
      <div className="grid gap-3 lg:grid-cols-2">
        <Specimen title="KeyValueList" source="shared/ui/key-value-list.tsx">
          <KeyValueList
            entries={[
              { key: 'host', label: 'Computer', value: 'Sample computer' },
              { key: 'branch', label: 'Branch', value: 'sample/feature' },
              { key: 'mode', label: 'Permissions', value: 'Read-only' },
              {
                key: 'path',
                label: 'Folder',
                value: 'C:\\samples\\a-long-folder-name\\that-wraps-anywhere',
              },
            ]}
          />
        </Specimen>
        <Specimen title="CodeBlock" source="shared/ui/code-block.tsx">
          <CodeBlock code={SAMPLE_CODE} label="greet.ts" />
          <CodeBlock code="bun run check" />
        </Specimen>
      </div>
    </CatalogSection>
  );
}

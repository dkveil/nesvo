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
import { SettingsRow, SettingsSection } from '@/shared/ui/settings-section';
import {
  Composer,
  ComposerInput,
  ComposerSend,
  ComposerToolbar,
} from '@/shared/ui/composer';
import { ComposerEditor } from '@/shared/ui/composer-editor';
import { AttachmentToken } from '@/shared/ui/attachment-token';
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
import { ResizeHandle } from '@/shared/ui/resize-handle';
import { Separator } from '@/shared/ui/separator';
import { FileGlyph } from '@/entities/file-change';
import {
  CatalogSection,
  Specimen,
  SpecimenRow,
  StateCaption,
} from './specimen';

const SAMPLE_TOKEN_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#3b82f6"/></svg>',
)}`;

const SAMPLE_CODE = `export function greet(name: string) {
  return \`Hello, \${name}\`;
}`;

function Composers() {
  const [draft, setDraft] = useState('');
  const [comment, setComment] = useState('Sample review comment');
  const [inlineDraft, setInlineDraft] = useState<{
    value: string;
    offsets: Record<string, number>;
  }>({
    value: 'Look at  here and compare it with .',
    offsets: { image: 8, image2: 34 },
  });
  const [inlineTokens, setInlineTokens] = useState(['image', 'image2']);
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
      <StateCaption label="editor · inline image tokens">
        <form className="w-full" onSubmit={event => event.preventDefault()}>
          <Composer>
            <ComposerEditor
              aria-label="Sample message with images"
              placeholder="Ask for a change"
              value={inlineDraft.value}
              tokens={inlineTokens.map(token => ({
                id: token,
                offset: inlineDraft.offsets[token] ?? 0,
                content: (
                  <AttachmentToken
                    name={`${token}.png`}
                    detail="13 KB"
                    src={SAMPLE_TOKEN_IMAGE}
                  />
                ),
              }))}
              onChange={({ value, offsets, removed }) => {
                setInlineTokens(previous =>
                  previous.filter(token => !removed.includes(token)),
                );
                setInlineDraft(previous => ({
                  value,
                  offsets: { ...previous.offsets, ...offsets },
                }));
              }}
            />
            <ComposerToolbar
              end={<ComposerSend disabled={!inlineDraft.value.trim()} />}
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

const SAMPLE_EDGE_MIN_PX = 160;
const SAMPLE_EDGE_MAX_PX = 320;
const SAMPLE_CORNER_MIN_PX = 120;
const SAMPLE_CORNER_MAX_PX = 240;
const SAMPLE_STEP_PX = 16;

const clampSample = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function ResizeHandles() {
  const [width, setWidth] = useState(224);
  const [box, setBox] = useState({ width: 176, height: 128 });
  const [edgeStart, setEdgeStart] = useState(width);
  const [boxStart, setBoxStart] = useState(box);
  const resizeEdge = (next: number) =>
    setWidth(clampSample(next, SAMPLE_EDGE_MIN_PX, SAMPLE_EDGE_MAX_PX));
  const resizeBox = (next: { width: number; height: number }) =>
    setBox({
      width: clampSample(
        next.width,
        SAMPLE_CORNER_MIN_PX,
        SAMPLE_CORNER_MAX_PX,
      ),
      height: clampSample(
        next.height,
        SAMPLE_CORNER_MIN_PX,
        SAMPLE_CORNER_MAX_PX,
      ),
    });
  return (
    <SpecimenRow label="edge · corner · focus" className="items-end gap-8">
      <StateCaption label={`edge · ${width}px · ← →`}>
        <div
          style={{ width }}
          className="relative h-28 rounded-surface border bg-background"
        >
          <ResizeHandle
            label="Resize sample panel"
            hint="Drag to resize"
            edge="right"
            aria-valuenow={width}
            aria-valuemin={SAMPLE_EDGE_MIN_PX}
            aria-valuemax={SAMPLE_EDGE_MAX_PX}
            onResizeStart={() => setEdgeStart(width)}
            onResize={offset => resizeEdge(edgeStart + offset.x)}
            onStep={direction =>
              resizeEdge(width + direction.x * SAMPLE_STEP_PX)
            }
          />
        </div>
      </StateCaption>
      <StateCaption label={`corner · ${box.width}×${box.height} · arrows`}>
        <div
          style={box}
          className="relative rounded-overlay border bg-background"
        >
          <ResizeHandle
            variant="corner"
            corner="top-left"
            label="Resize sample dock"
            hint="Drag to resize. Arrow keys resize too."
            onResizeStart={() => setBoxStart(box)}
            onResize={offset =>
              resizeBox({
                width: boxStart.width - offset.x,
                height: boxStart.height - offset.y,
              })
            }
            onStep={direction =>
              resizeBox({
                width: box.width - direction.x * SAMPLE_STEP_PX,
                height: box.height - direction.y * SAMPLE_STEP_PX,
              })
            }
          />
        </div>
      </StateCaption>
      <StateCaption label="edge · focus">
        <div className="relative h-28 w-24 rounded-surface border bg-background">
          <ResizeHandle
            label="Focused sample handle"
            edge="right"
            data-preview-focus=""
            onResize={() => undefined}
          />
        </div>
      </StateCaption>
      <StateCaption label="corner · focus">
        <div className="relative size-28 rounded-overlay border bg-background">
          <ResizeHandle
            variant="corner"
            label="Focused sample corner"
            data-preview-focus=""
            onResize={() => undefined}
          />
        </div>
      </StateCaption>
    </SpecimenRow>
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
            <PanelAction label="Refresh">
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
          <CodeBlock code="nesvo --help" label="Shell" variant="flat" />
        </Specimen>
        <Specimen
          title="SettingsSection"
          source="shared/ui/settings-section.tsx"
        >
          <SettingsSection title="Appearance">
            <SettingsRow title="Color scheme" description="System" />
          </SettingsSection>
          <SettingsSection
            title="Devices"
            actionLayout="stacked"
            action={<Button size="xs">Add device</Button>}
          >
            <SettingsRow title="Release runner" />
            <SettingsRow title="Build server" />
          </SettingsSection>
        </Specimen>
        <Specimen title="Separator" source="shared/ui/separator.tsx">
          <Separator />
          <Separator label="Mode changed to Accept edits" />
        </Specimen>
      </div>
      <Specimen title="ResizeHandle" source="shared/ui/resize-handle.tsx">
        <ResizeHandles />
      </Specimen>
    </CatalogSection>
  );
}

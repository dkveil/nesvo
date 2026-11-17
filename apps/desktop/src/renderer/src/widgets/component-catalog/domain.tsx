import {
  DiffStat,
  FileGlyph,
  StatusLetter,
  type FileChangeStatus,
} from '@/entities/file-change';
import { StatusIcon, type StatusKind } from '@/entities/status';
import { ProjectChip } from '@/shared/ui/project-chip';
import {
  CatalogSection,
  Specimen,
  SpecimenRow,
  StateCaption,
} from './specimen';

const STATUSES: StatusKind[] = [
  'success',
  'error',
  'warning',
  'info',
  'pending',
  'running',
  'idle',
];

const FILE_STATUSES: FileChangeStatus[] = [
  'added',
  'modified',
  'removed',
  'renamed',
  'copied',
  'unchanged',
];

const FILE_NAMES = [
  'app.tsx',
  'package.json',
  'readme.md',
  'styles.css',
  'config.yaml',
  'logo.svg',
  'notes',
];

export function DomainSection() {
  return (
    <CatalogSection
      id="domain"
      title="Domain glyphs"
      description="Entity-level building blocks that carry meaning, kept in entities/status and entities/file-change."
    >
      <Specimen title="StatusIcon" source="entities/status">
        <SpecimenRow label="status" className="gap-4">
          {STATUSES.map(status => (
            <StateCaption key={status} label={status}>
              <StatusIcon status={status} className="size-3.5" />
            </StateCaption>
          ))}
        </SpecimenRow>
      </Specimen>
      <Specimen
        title="DiffStat, StatusLetter, FileGlyph, ProjectChip"
        source="entities/file-change · shared/ui/project-chip"
      >
        <SpecimenRow label="diff stat">
          <DiffStat additions={128} deletions={14} />
          <DiffStat additions={3} deletions={0} size="sm" />
        </SpecimenRow>
        <SpecimenRow label="status letter" className="gap-3">
          {FILE_STATUSES.map(status => (
            <StateCaption key={status} label={status}>
              <StatusLetter status={status} />
            </StateCaption>
          ))}
        </SpecimenRow>
        <SpecimenRow label="file glyph" className="gap-3">
          {FILE_NAMES.map(name => (
            <span
              key={name}
              className="inline-flex items-center gap-1.5 text-xs"
            >
              <FileGlyph name={name} />
              {name}
            </span>
          ))}
        </SpecimenRow>
        <SpecimenRow label="project chip" className="gap-3">
          {['sample-app', 'sample-api', 'sample-docs', 'sample-site'].map(
            name => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 text-xs"
              >
                <ProjectChip label={name} />
                {name}
              </span>
            ),
          )}
        </SpecimenRow>
      </Specimen>
    </CatalogSection>
  );
}

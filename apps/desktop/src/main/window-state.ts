import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, type BrowserWindow, type Rectangle } from 'electron';
import { z } from 'zod';
import { log } from './logging';

const WINDOW_STATE_FILE = 'window-state.json';
const DEFAULT_WIDTH = 1320;
const DEFAULT_HEIGHT = 860;
export const MIN_WINDOW_WIDTH = 640;
export const MIN_WINDOW_HEIGHT = 480;
const MIN_VISIBLE_WIDTH_PX = 160;
const MIN_VISIBLE_HEIGHT_PX = 48;
const MAX_COORDINATE = 100_000;

const coordinateSchema = z
  .number()
  .int()
  .min(-MAX_COORDINATE)
  .max(MAX_COORDINATE);
const windowStateSchema = z.strictObject({
  x: coordinateSchema.optional(),
  y: coordinateSchema.optional(),
  width: z.number().int().min(MIN_WINDOW_WIDTH).max(MAX_COORDINATE),
  height: z.number().int().min(MIN_WINDOW_HEIGHT).max(MAX_COORDINATE),
  maximized: z.boolean(),
});
type WindowState = z.infer<typeof windowStateSchema>;

const defaults: WindowState = {
  width: DEFAULT_WIDTH,
  height: DEFAULT_HEIGHT,
  maximized: false,
};

const overlap = (bounds: Rectangle, area: Rectangle) => ({
  width:
    Math.min(bounds.x + bounds.width, area.x + area.width) -
    Math.max(bounds.x, area.x),
  height:
    Math.min(bounds.y + bounds.height, area.y + area.height) -
    Math.max(bounds.y, area.y),
});

const fitToDisplay = (state: WindowState): WindowState => {
  if (state.x === undefined || state.y === undefined) {
    const area = screen.getPrimaryDisplay().workArea;
    return {
      maximized: state.maximized,
      width: Math.max(MIN_WINDOW_WIDTH, Math.min(state.width, area.width)),
      height: Math.max(MIN_WINDOW_HEIGHT, Math.min(state.height, area.height)),
    };
  }
  const bounds = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
  };
  const area = screen.getDisplayMatching(bounds).workArea;
  const visible = overlap(bounds, area);
  if (
    visible.width < MIN_VISIBLE_WIDTH_PX ||
    visible.height < MIN_VISIBLE_HEIGHT_PX
  )
    return fitToDisplay({
      width: state.width,
      height: state.height,
      maximized: state.maximized,
    });
  return {
    ...state,
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(state.width, area.width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.min(state.height, area.height)),
  };
};

export const readWindowState = (directory: string): WindowState => {
  try {
    const parsed = windowStateSchema.safeParse(
      JSON.parse(readFileSync(join(directory, WINDOW_STATE_FILE), 'utf8')),
    );
    return fitToDisplay(parsed.success ? parsed.data : defaults);
  } catch {
    return fitToDisplay(defaults);
  }
};

export const saveWindowState = (directory: string, window: BrowserWindow) => {
  const bounds = window.getNormalBounds();
  const state = windowStateSchema.safeParse({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
    maximized: window.isMaximized(),
  });
  if (!state.success) return;
  const target = join(directory, WINDOW_STATE_FILE);
  const temporary = `${target}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state.data));
    renameSync(temporary, target);
  } catch {
    log.warn('The window position could not be saved.');
  }
};

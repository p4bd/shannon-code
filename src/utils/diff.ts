export function createUnifiedDiff(input: {
  path: string;
  oldContent: string;
  newContent: string;
  contextLines?: number;
}): string {
  if (input.oldContent === input.newContent) {
    return `No changes for ${input.path}`;
  }

  const oldLines = splitLines(input.oldContent);
  const newLines = splitLines(input.newContent);
  const contextLines = input.contextLines ?? 3;
  const hunk = createChangedHunk({
    oldLines,
    newLines,
    contextLines,
  });

  return [
    `--- a/${input.path}`,
    `+++ b/${input.path}`,
    `@@ -${formatRangeStart(hunk.oldStart, hunk.oldLength)},${hunk.oldLength} +${formatRangeStart(
      hunk.newStart,
      hunk.newLength,
    )},${hunk.newLength} @@`,
    ...hunk.lines,
  ].join("\n");
}

function createChangedHunk(input: {
  oldLines: string[];
  newLines: string[];
  contextLines: number;
}): {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  lines: string[];
} {
  let prefixLength = 0;
  while (
    prefixLength < input.oldLines.length &&
    prefixLength < input.newLines.length &&
    input.oldLines[prefixLength] === input.newLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let oldChangeEnd = input.oldLines.length - 1;
  let newChangeEnd = input.newLines.length - 1;
  while (
    oldChangeEnd >= prefixLength &&
    newChangeEnd >= prefixLength &&
    input.oldLines[oldChangeEnd] === input.newLines[newChangeEnd]
  ) {
    oldChangeEnd -= 1;
    newChangeEnd -= 1;
  }

  const oldStart = Math.max(0, prefixLength - input.contextLines);
  const newStart = Math.max(0, prefixLength - input.contextLines);
  const oldEnd = Math.min(
    input.oldLines.length - 1,
    oldChangeEnd + input.contextLines,
  );
  const newEnd = Math.min(
    input.newLines.length - 1,
    newChangeEnd + input.contextLines,
  );
  const lines: string[] = [];

  for (let index = oldStart; index < prefixLength; index += 1) {
    lines.push(` ${input.oldLines[index]}`);
  }
  for (let index = prefixLength; index <= oldChangeEnd; index += 1) {
    lines.push(`-${input.oldLines[index]}`);
  }
  for (let index = prefixLength; index <= newChangeEnd; index += 1) {
    lines.push(`+${input.newLines[index]}`);
  }
  for (let index = newChangeEnd + 1; index <= newEnd; index += 1) {
    lines.push(` ${input.newLines[index]}`);
  }

  return {
    oldStart,
    oldLength: oldEnd >= oldStart ? oldEnd - oldStart + 1 : 0,
    newStart,
    newLength: newEnd >= newStart ? newEnd - newStart + 1 : 0,
    lines,
  };
}

function formatRangeStart(start: number, length: number): number {
  return length === 0 ? 0 : start + 1;
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  return content.endsWith("\n")
    ? content.slice(0, -1).split(/\r?\n/)
    : content.split(/\r?\n/);
}

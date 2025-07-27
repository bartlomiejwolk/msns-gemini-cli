/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// msns: JS glob library impl. replaced with Ripgrep.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { BaseTool, Icon, ToolResult } from './tools.js';
import { Type } from '@google/genai';
import { shortenPath, makeRelative } from '../utils/paths.js';
import { isWithinRoot } from '../utils/fileUtils.js';
import { Config } from '../config/config.js';

// Subset of 'Path' interface provided by 'glob' that we can implement for testing
export interface GlobPath {
  fullpath(): string;
  mtimeMs?: number;
}

/**
 * Sorts file entries based on recency and then alphabetically.
 * Recent files (modified within recencyThresholdMs) are listed first, newest to oldest.
 * Older files are listed after recent ones, sorted alphabetically by path.
 */
export function sortFileEntries(
  entries: GlobPath[],
  nowTimestamp: number,
  recencyThresholdMs: number,
): GlobPath[] {
  const sortedEntries = [...entries];
  sortedEntries.sort((a, b) => {
    const mtimeA = a.mtimeMs ?? 0;
    const mtimeB = b.mtimeMs ?? 0;
    const aIsRecent = nowTimestamp - mtimeA < recencyThresholdMs;
    const bIsRecent = nowTimestamp - mtimeB < recencyThresholdMs;

    if (aIsRecent && bIsRecent) {
      return mtimeB - mtimeA;
    } else if (aIsRecent) {
      return -1;
    } else if (bIsRecent) {
      return 1;
    } else {
      return a.fullpath().localeCompare(b.fullpath());
    }
  });
  return sortedEntries;
}

/**
 * Parameters for the GlobTool
 */
export interface GlobToolParams {
  /**
   * The glob pattern to match files against
   */
  pattern: string;

  /**
   * The directory to search in (optional, defaults to current directory)
   */
  path?: string;

  /**
   * Whether the search should be case‑sensitive (kept for API compatibility,
   * ignored because the search is always case‑insensitive)
   */
  case_sensitive?: boolean;

  /**
   * Whether to respect .gitignore patterns (kept for API compatibility,
   * ignored because the search always scans all files)
   */
  respect_git_ignore?: boolean;
}

/**
 * Implementation of the Glob tool logic
 */
export class GlobTool extends BaseTool<GlobToolParams, ToolResult> {
  static readonly Name = 'glob';

  constructor(private config: Config) {
    super(
      GlobTool.Name,
      'FindFiles',
      'Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths.',
      Icon.FileSearch,
      {
        properties: {
          pattern: {
            description:
              "The glob pattern to match against (e.g., '**/*.py', 'docs/*.md').",
            type: Type.STRING,
          },
          path: {
            description:
              'Optional: The absolute path to the directory to search within. If omitted, searches the root directory.',
            type: Type.STRING,
          },
          case_sensitive: {
            description:
              'Kept for compatibility; search is always case‑insensitive.',
            type: Type.BOOLEAN,
          },
          respect_git_ignore: {
            description:
              'Kept for compatibility; .gitignore files are always ignored.',
            type: Type.BOOLEAN,
          },
        },
        required: ['pattern'],
        type: Type.OBJECT,
      },
    );
  }

  /**
   * Validates the parameters for the tool.
   */
  validateToolParams(params: GlobToolParams): string | null {
    const errors = SchemaValidator.validate(this.schema.parameters, params);
    if (errors) {
      return errors;
    }

    const searchDirAbsolute = path.resolve(
      this.config.getTargetDir(),
      params.path || '.',
    );

    if (!isWithinRoot(searchDirAbsolute, this.config.getTargetDir())) {
      return `Search path ("${searchDirAbsolute}") resolves outside the tool's root directory ("${this.config.getTargetDir()}").`;
    }

    try {
      if (!fs.existsSync(searchDirAbsolute)) {
        return `Search path does not exist: ${searchDirAbsolute}`;
      }
      if (!fs.statSync(searchDirAbsolute).isDirectory()) {
        return `Search path is not a directory: ${searchDirAbsolute}`;
      }
    } catch (e: unknown) {
      return `Error accessing search path: ${e}`;
    }

    if (
      !params.pattern ||
      typeof params.pattern !== 'string' ||
      params.pattern.trim() === ''
    ) {
      return "The 'pattern' parameter cannot be empty.";
    }

    return null;
  }

  /**
   * Gets a description of the glob operation.
   */
  getDescription(params: GlobToolParams): string {
    let description = `'${params.pattern}'`;
    if (params.path) {
      const searchDir = path.resolve(
        this.config.getTargetDir(),
        params.path || '.',
      );
      const relativePath = makeRelative(searchDir, this.config.getTargetDir());
      description += ` within ${shortenPath(relativePath)}`;
    }
    return description;
  }

  /**
   * Executes the glob search with the given parameters using ripgrep.
   */
  async execute(params: GlobToolParams): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: `Error: Invalid parameters provided. Reason: ${validationError}`,
        returnDisplay: validationError,
      };
    }

    try {
      const searchDirAbsolute = path.resolve(
        this.config.getTargetDir(),
        params.path || '.',
      );

      // Build ripgrep arguments ensuring proper escaping and portability
      const rgArgs = [
        '--files',
        '--null',
        '--glob',
        params.pattern,
        '--glob-case-insensitive', // Use case-insensitive glob matching
        '--no-ignore', // always scan all files, ignore .gitignore
      ];

      const rgResult = spawnSync('rg', rgArgs, {
        cwd: searchDirAbsolute,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024, // 10 MB safety buffer
      });

      if (rgResult.error) {
        return {
          llmContent: `Error during ripgrep search: ${rgResult.error.message}`,
          returnDisplay: 'Error: ripgrep failed.',
        };
      }

      if (rgResult.stderr) {
        console.error(`ripgrep stderr: ${rgResult.stderr}`);
      }

      const allFilePaths = rgResult.stdout
        .split('\0') // --null output
        .filter(Boolean)
        .map((p) => path.resolve(searchDirAbsolute, p));

      const totalRgCount = allFilePaths.length;
      const maxResults = 2000;
      let truncatedCount = 0;
      let filePathsToDisplay = allFilePaths;

      if (totalRgCount > maxResults) {
        filePathsToDisplay = allFilePaths.slice(0, maxResults);
        truncatedCount = totalRgCount - maxResults;
      }

      const displayedCount = filePathsToDisplay.length;

      if (displayedCount === 0) {
        return {
          llmContent: `Search term: ${params.pattern}\n\nNo files found matching pattern "${params.pattern}"\n\nFound 0 file(s).`,
          returnDisplay: 'No files found',
        };
      }

      const fileListDescription = filePathsToDisplay.join('\n');
      let llmContent = `Search term: ${params.pattern}\n\n${fileListDescription}\n\nFound ${displayedCount} file(s).`;

      if (truncatedCount > 0) {
        llmContent += ` Output truncated. ${totalRgCount} results returned by ripgrep, ${truncatedCount} truncated.`;
      }

      return {
        llmContent,
        returnDisplay: `Found ${displayedCount} matching file(s)`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`GlobTool execute Error: ${errorMessage}`, error);
      return {
        llmContent: `Error during glob search operation: ${errorMessage}`,
        returnDisplay: 'Error: An unexpected error occurred.',
      };
    }
  }
}

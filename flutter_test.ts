#!/usr/bin/env -S deno run -A

// cSpell:words goldens

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7";
import $, { CommandResult } from "jsr:@david/dax@0.42.0";
import * as parser from "jsr:@fenv-org/flutter-test-output-parser@1.0.1";
import { existsSync } from "jsr:@std/fs@^1.0.4";
import { dirname, join } from "jsr:@std/path@^1.0.0";
import { stringify } from "jsr:@std/yaml@^1.0.5";
import os from "node:os";

// Create command instance
const command = new Command()
  .name("ft")
  .version("0.3.0-snapshot")
  .description("Run flutter tests and generate a report.")
  .usage("[options] -- [rawOptions]")
  .example(
    "ft -G -o build/test_report.yaml -- --timeout 60s",
    "Runs with the good concurrency and timeout 60 seconds.\nThe report will be saved to build/test_report.yaml.",
  )
  .example(
    "ft -AMp",
    "Runs with the maximum concurrency for all projects and open the report if failed or skipped.",
  )
  .example(
    "ft -ug -- /test/path/to/flutter_test.dart",
    "Runs with `--tags golden --update-goldens` for the specific test file.",
  )
  .option("-G --good", "Run tests with 2/3 concurrency. This is default.", {
    conflicts: ["half", "max"],
  })
  .option("-M --max", "Run tests with maximum concurrency.", {
    conflicts: ["half", "good"],
  })
  .option("-H --half", "Run tests with half concurrency.", {
    conflicts: ["max", "good"],
  })
  .option("-o --output <file:file>", "Output file.", {
    default: "build/test_report.yaml",
  })
  .option("-u --update-goldens", "Update golden files.")
  .option("-g --golden", "Add `--tags golden` to flutter test.")
  .option("--no-golden", "Add `--exclude-tags golden` to flutter test.")
  .option("-p --open", "Open the output file.")
  .option(
    "-A --all",
    "Run tests for all melos projects. If not melos project, it will run tests in the current directory only.",
    { conflicts: ["no-melos"] },
  )
  .option(
    "--melos",
    "Run tests with `melos exec`. If not melos project, it works like `--no-melos`.",
    { default: false },
  )
  .option(
    "--no-melos",
    "Run tests in the current directory without melos.",
    { conflicts: ["all"] },
  );

// Define command options type using typeof command
type CommandFlags = Awaited<ReturnType<typeof command.parse>>;

async function main(args: string[]): Promise<void> {
  const flag: CommandFlags = await command.parse(args);

  const { output, all, melos } = flag.options;

  // Calculate concurrency
  const concurrency = calculateConcurrency({
    max: flag.options.max,
    half: flag.options.half,
    good: flag.options.good,
  });
  console.error(`Run with ${concurrency} concurrency.`);

  // Check if it's a Melos project
  const usesMelos = isMelosProject() && melos;

  if (all && usesMelos) {
    // Get Melos projects that have test directories
    const projectsWithTests = await getMelosProjectsWithTests();
    if (projectsWithTests.length === 0) {
      console.error(
        "No projects with test directories found in this Melos project.",
      );
      Deno.exit(1);
    }

    console.error(
      `Found ${projectsWithTests.length} projects with test directories.`,
    );
  }

  // Run tests
  const tempOutput = "build/test_report.output";
  let result: CommandResult | undefined;

  if (!usesMelos) {
    result = await runWithoutMelos({
      concurrency,
      tempOutput,
      flag,
    });
  } else {
    result = await runWithMelos({
      concurrency,
      tempOutput,
      flag,
    });
  }

  if (result && result.code) {
    console.error("Test failed");
  }

  if (flag.options.open && existsSync(output)) {
    await $`open ${$.path(output)}`;
  }

  Deno.exit(result?.code ?? 0);
}

// Run tests without Melos
async function runWithoutMelos(params: {
  concurrency: number;
  tempOutput: string;
  flag: CommandFlags;
}): Promise<CommandResult | undefined> {
  const { concurrency, tempOutput, flag } = params;
  const { output, updateGoldens, golden } = flag.options;

  await $`rm -f ${$.path(tempOutput)} ${$.path(output)}`.noThrow();
  const flutterArgs = [
    "test",
    "-j",
    `${concurrency}`,
    `--file-reporter=json:${tempOutput}`,
    ...(updateGoldens ? ["--update-goldens"] : []),
    ...(golden === true
      ? ["--tags", "golden"]
      : golden === false
      ? ["--exclude-tags", "golden"]
      : []),
    ...flag.literal,
  ];
  const result = await $`flutter ${flutterArgs}`.noThrow();

  if (!existsSync(tempOutput) && result) {
    console.error("There was no test result");
    Deno.exit(result.code);
  }

  const { trees, totalDurationInSeconds } = await analyzeTestResults(
    tempOutput,
  );
  const { succeededTests, failedTests, skippedTests } = categorizeTests(trees);

  // Print test results
  printTestResults(
    succeededTests,
    failedTests,
    skippedTests,
    totalDurationInSeconds,
  );

  // Generate and save test summary
  saveTestReport(generateTestSummary(failedTests, skippedTests), output);

  return result;
}

// Run tests with Melos
async function runWithMelos(params: {
  concurrency: number;
  tempOutput: string;
  flag: CommandFlags;
}): Promise<CommandResult | undefined> {
  const { concurrency, tempOutput, flag } = params;
  const { output, updateGoldens, golden, all } = flag.options;

  // Run tests only for selected projects in Melos project
  const scopeArgs = all ? [] : [`--scope=${(await getCurrentPackage())?.name}`];
  const projectsWithTests = await getMelosProjectsWithTests();
  console.error(
    `Running tests for ${projectsWithTests.length} projects with test directories.`,
  );

  await $`rm -f ${$.path(output)}`.noThrow();
  let melosArgs = [
    "exec",
    ...scopeArgs,
    `--file-exists=${$.path(tempOutput)}`,
  ];
  await $`melos ${melosArgs} -- 'rm -f ${$.path(tempOutput)}'`
    .stdout("null")
    .stderr("null")
    .noThrow();

  const rawArgs: string[] = [
    "flutter",
    "test",
    `-j=${concurrency}`,
    `--file-reporter=json:${tempOutput}`,
  ];
  if (updateGoldens) {
    rawArgs.push("--update-goldens");
  }
  if (golden) {
    rawArgs.push("--tags", "golden");
  } else if (golden === false) {
    rawArgs.push("--exclude-tags", "golden");
  }
  const rawArgsString = rawArgs.join(" ");
  melosArgs = [
    "exec",
    ...scopeArgs,
    "--dir-exists=test",
    "-c",
    "1",
    "-fo",
    "--",
    rawArgsString,
  ];

  const testResult = await $`melos ${melosArgs}`.noThrow();
  let mergedTotalDurationInSec = 0;
  const mergedSucceededTests: parser.TestTree[] = [];
  const mergedFailedTests: parser.TestTree[] = [];
  const mergedSkippedTests: parser.TestTree[] = [];

  const projects = await melosList({
    scope: scopeArgs,
    fileExists: tempOutput,
  });
  for (const project of projects) {
    const { trees, totalDurationInSeconds } = await analyzeTestResults(
      join(project.location, tempOutput),
    );
    const { succeededTests, failedTests, skippedTests } = categorizeTests(
      trees,
    );
    mergedTotalDurationInSec += totalDurationInSeconds;
    mergedSucceededTests.push(...succeededTests);
    mergedFailedTests.push(...failedTests);
    mergedSkippedTests.push(...skippedTests);
  }

  // Print test results
  printTestResults(
    mergedSucceededTests,
    mergedFailedTests,
    mergedSkippedTests,
    mergedTotalDurationInSec,
  );

  // Generate and save test summary
  saveTestReport(
    generateTestSummary(mergedFailedTests, mergedSkippedTests),
    output,
  );

  return testResult;
}

// Utility functions
function urlToFilepath(fileUrl: string | undefined | null) {
  return fileUrl ? new URL(fileUrl).pathname : fileUrl;
}

// Find the corresponding BDD feature file
function featureFile(fileUrl: string) {
  const featureUrl = fileUrl.replace(/_test\.dart$/, ".feature");
  return existsSync(new URL(featureUrl)) ? featureUrl : undefined;
}

// Calculate concurrency based on options
function calculateConcurrency(
  options: { max?: boolean; half?: boolean; good?: boolean },
): number {
  const numCores = os.availableParallelism();
  if (options.max) {
    return numCores - 1;
  } else if (options.half) {
    return Math.ceil(numCores / 2);
  } else {
    return Math.ceil((numCores * 2) / 3);
  }
}

// Analyze test results
function analyzeTestResults(
  tempOutput: string,
): Promise<parser.FlutterTestOutput> {
  return parser.parseAsync(tempOutput);
}

// Categorize tests
function categorizeTests(
  trees: parser.FlutterTestOutput["trees"],
): {
  succeededTests: parser.TestTree[];
  failedTests: parser.TestTree[];
  skippedTests: parser.TestTree[];
} {
  const succeededTests: parser.TestTree[] = [];
  const failedTests: parser.TestTree[] = [];
  const skippedTests: parser.TestTree[] = [];

  for (const tree of trees.values()) {
    if (tree.type === "testStart") {
      if (tree.done?.result === "error" || tree.done?.result === "failure") {
        failedTests.push(tree);
      } else if (tree.done?.skipped) {
        skippedTests.push(tree);
      } else {
        succeededTests.push(tree);
      }
    }
  }

  return { succeededTests, failedTests, skippedTests };
}

// Generate test summary
type TestSummary = {
  failedTestCount: number;
  failed: {
    file: string | null | undefined;
    line: number | null;
    column: number | null;
    feature: string | null | undefined;
    name: string;
    messages: string;
    errors: {
      error: string;
      stackTrace: string;
    }[];
  }[];
  skippedTestCount: number;
  skipped: {
    file: string | null | undefined;
    line: number | null;
    column: number | null;
    feature: string | null | undefined;
    name: string;
    reason: string | null;
  }[];
};

function generateTestSummary(
  failedTests: parser.TestTree[],
  skippedTests: parser.TestTree[],
): TestSummary {
  const summary: TestSummary = {
    failedTestCount: failedTests.length,
    failed: [],
    skippedTestCount: skippedTests.length,
    skipped: [],
  };

  for (const test of failedTests) {
    const fileUrl = test.test.root_url ?? `file://${test.suite.suite.path}`;
    summary.failed.push({
      file: urlToFilepath(fileUrl),
      line: test.test.root_line ?? test.test.line,
      column: test.test.root_column ?? test.test.column,
      feature: urlToFilepath(featureFile(fileUrl)),
      name: test.test.name,
      messages: test.print?.map((p) => p.message).join("\n") ?? "",
      errors: test.error?.map((e) => ({
        error: e.error,
        stackTrace: e.stackTrace,
      })) ?? [],
    });
  }

  for (const test of skippedTests) {
    const fileUrl = test.test.root_url ?? `file://${test.suite.suite.path}`;
    summary.skipped.push({
      file: urlToFilepath(fileUrl),
      line: test.test.root_line ?? test.test.line,
      column: test.test.root_column ?? test.test.column,
      feature: urlToFilepath(featureFile(fileUrl)),
      name: test.test.name,
      reason: test.test.metadata.skipReason,
    });
  }

  return summary;
}

// Print test results
function printTestResults(
  succeededTests: parser.TestTree[],
  failedTests: parser.TestTree[],
  skippedTests: parser.TestTree[],
  totalDurationInSeconds: number,
): void {
  console.error(
    `All tests: ${
      succeededTests.length + failedTests.length + skippedTests.length
    }`,
  );
  console.error(`Succeeded tests: ${succeededTests.length}`);
  console.error(`Failed tests: ${failedTests.length}`);
  console.error(`Skipped tests: ${skippedTests.length}`);
  console.error(
    `Total duration: ${Math.floor(totalDurationInSeconds / 60)} mins ` +
      `${Math.floor(totalDurationInSeconds % 60)} sec`,
  );
}

// Save test report
function saveTestReport(summary: any, output: string): void {
  if (summary.failed.length > 0 || summary.skipped.length > 0) {
    const yaml = stringify(
      JSON.parse(JSON.stringify(summary)),
      { lineWidth: 1024 },
    );
    Deno.writeTextFileSync(output, yaml);
    console.error(`Test report is saved to ${output}`);
  }
}

async function melosList(options?: {
  scope?: string | string[];
  dirExists?: string | string[];
  fileExists?: string | string[];
  dependsOn?: string | string[];
}): Promise<{ name: string; location: string; type: MelosProjectType }[]> {
  const { scope, dirExists, fileExists, dependsOn } = options ?? {};

  const args: string[] = [];
  if (scope) {
    asArray(scope).forEach((s) => args.push(`--scope=${s}`));
  }
  if (dirExists) {
    asArray(dirExists).forEach((d) => args.push(`--dir-exists=${d}`));
  }
  if (fileExists) {
    asArray(fileExists).forEach((f) => args.push(`--file-exists=${f}`));
  }
  if (dependsOn) {
    asArray(dependsOn).forEach((d) => args.push(`--depends-on=${d}`));
  }

  const result = await $`melos list --json ${args}`.stdout("piped").noThrow();
  if (result.code !== 0) {
    Deno.exit(result.code);
  }
  return JSON.parse(result.stdout);
}

enum MelosProjectType {
  DART_PACKAGE = 0,
  FLUTTER_PACKAGE = 1,
  FLUTTER_PLUGIN = 2,
  FLUTTER_APP = 3,
}

function isMelosProject(): boolean {
  let currentDir = Deno.cwd();
  while (currentDir !== "/") {
    if (existsSync(join(currentDir, "melos.yaml"))) {
      return true;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  return false;
}

// Get Melos projects that have test directories
async function getMelosProjectsWithTests(scope?: string | string[]): Promise<
  { name: string; location: string }[]
> {
  try {
    const projects = await melosList({ scope, dirExists: "test" });
    const projectsWithTests: { name: string; location: string }[] = projects
      .map((project) => ({ name: project.name, location: project.location }));

    return projectsWithTests;
  } catch (error) {
    console.error("Error getting Melos projects:", error);
    return [];
  }
}

// Get current package from Melos projects
async function getCurrentPackage(): Promise<
  { name: string; location: string } | null
> {
  const projects = await melosList();
  const currentDir = Deno.cwd();
  let longestMatch: { name: string; location: string; length: number } | null =
    null;

  for (const project of projects) {
    if (currentDir.startsWith(project.location)) {
      if (!longestMatch || project.location.length > longestMatch.length) {
        longestMatch = {
          name: project.name,
          location: project.location,
          length: project.location.length,
        };
      }
    }
  }

  return longestMatch
    ? { name: longestMatch.name, location: longestMatch.location }
    : null;
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

if (import.meta.main) {
  await main(Deno.args);
}

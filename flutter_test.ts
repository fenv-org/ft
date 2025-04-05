#!/usr/bin/env -S deno run -A

// cSpell:words goldens

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7";
import $, { CommandResult } from "jsr:@david/dax@0.42.0";
import { existsSync } from "jsr:@std/fs@^1.0.4";
import { dirname, join } from "jsr:@std/path@^1.0.0";
import { TextLineStream } from "jsr:@std/streams@^1.0.9";
import { stringify } from "jsr:@std/yaml@^1.0.5";
import os from "node:os";

// Create command instance
const command = new Command()
  .name("ft")
  .version("0.2.0-alpha.13")
  .description("Run flutter tests and generate a report.")
  .usage("[options] -- [flutter test options]")
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
    "--no-melos",
    "Run tests in the current directory without melos.",
    { conflicts: ["all"] },
  )
  .option("--debug-parse <file:file>", "Debug parsing test report.");

// Define command options type using typeof command
type CommandFlags = Awaited<ReturnType<typeof command.parse>>;

async function main(args: string[]): Promise<void> {
  const flag: CommandFlags = await command.parse(args);

  const { output, debugParse, all } = flag.options;

  // Calculate concurrency
  const concurrency = calculateConcurrency({
    max: flag.options.max,
    half: flag.options.half,
    good: flag.options.good,
  });
  console.error(`Run with ${concurrency} concurrency.`);

  // Check if it's a Melos project
  const isMelos = isMelosProject();

  if (all) {
    if (!isMelos) {
      console.error("This directory is not a Melos project.");
      Deno.exit(1);
    }

    // Get Melos projects that have test directories
    const projectsWithTests = await getMelosProjectsWithTests([]);
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
  const tempOutput = debugParse ? debugParse : "build/test_report.output";
  let result: CommandResult | undefined;

  if (debugParse) {
    result = await runDebugParse({
      tempOutput,
      flag,
    });
  } else if (!isMelos) {
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

async function runDebugParse(params: {
  tempOutput: string;
  flag: CommandFlags;
}) {
  const { tempOutput, flag } = params;
  const { output } = flag.options;
  let result: CommandResult | undefined;

  if (!existsSync(tempOutput) && result) {
    console.error("There was no test result");
    Deno.exit(result.code);
  }

  // Analyze test results
  const { trees, totalDurationInSec } = await analyzeTestResults(tempOutput);

  // Categorize tests
  const { succeededTests, failedTests, skippedTests } = categorizeTests(
    trees,
  );

  // Print test results
  printTestResults(
    succeededTests,
    failedTests,
    skippedTests,
    totalDurationInSec,
  );

  // Generate and save test summary
  const summary = generateTestSummary(failedTests, skippedTests);
  saveTestReport(summary, output);

  return result;
}

// Run tests without Melos
async function runWithoutMelos(params: {
  concurrency: number;
  tempOutput: string;
  flag: CommandFlags;
}): Promise<CommandResult | undefined> {
  const { concurrency, tempOutput, flag } = params;
  const { output, updateGoldens, golden } = flag.options;

  const result = await runFlutterTests({
    concurrency,
    tempOutput,
    output,
    updateGoldens: !!updateGoldens,
    golden,
    additionalArgs: flag.literal,
  });

  if (!existsSync(tempOutput) && result) {
    console.error("There was no test result");
    Deno.exit(result.code);
  }

  // Analyze test results
  const { trees, totalDurationInSec } = await analyzeTestResults(tempOutput);

  // Categorize tests
  const { succeededTests, failedTests, skippedTests } = categorizeTests(
    trees,
  );

  // Print test results
  printTestResults(
    succeededTests,
    failedTests,
    skippedTests,
    totalDurationInSec,
  );

  // Generate and save test summary
  const summary = generateTestSummary(failedTests, skippedTests);
  saveTestReport(summary, output);

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
  const projectsWithTests = await getMelosProjectsWithTests(scopeArgs);
  console.error(
    `Running tests for ${projectsWithTests.length} projects with test directories.`,
  );

  await $`rm -f ${$.path(output)}`.noThrow();
  await $`melos exec ${scopeArgs} --file-exists=${
    $.path(tempOutput)
  } -- 'rm -f ${$.path(tempOutput)}'`.stdout("null").stderr("null").noThrow();

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
  const melosArgs = [
    "exec",
    ...scopeArgs,
    "--dir-exists=test",
    "-c",
    "1",
    "-fo",
    "--",
    rawArgsString,
  ];

  return await $`melos ${melosArgs}`.noThrow();
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

// Run Flutter tests
type RunFlutterTestsParams = {
  concurrency: number;
  tempOutput: string;
  output: string;
  updateGoldens: boolean;
  golden: boolean | undefined;
  additionalArgs: string[];
  cwd?: string;
};

async function runFlutterTests(
  params: RunFlutterTestsParams,
): Promise<CommandResult | undefined> {
  const {
    concurrency,
    tempOutput,
    output,
    updateGoldens,
    golden,
    additionalArgs,
    cwd,
  } = params;

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
    ...additionalArgs,
  ];
  return await $`flutter ${flutterArgs}`.cwd(cwd ?? Deno.cwd()).noThrow();
}

// Analyze test results
async function analyzeTestResults(
  tempOutput: string,
): Promise<{
  trees: Map<number, SuiteTree | GroupTree | TestTree>;
  totalDurationInSec: number;
}> {
  const trees = new Map<number, SuiteTree | GroupTree | TestTree>();
  let totalDurationInSec = -1;

  for await (const element of readElements(tempOutput)) {
    buildTree(trees, element);
    if (element.type === "done") {
      totalDurationInSec = element.time / 1000;
    }
  }

  return { trees, totalDurationInSec };
}

// Categorize tests
function categorizeTests(
  trees: Map<number, SuiteTree | GroupTree | TestTree>,
): {
  succeededTests: TestTree[];
  failedTests: TestTree[];
  skippedTests: TestTree[];
} {
  const succeededTests: TestTree[] = [];
  const failedTests: TestTree[] = [];
  const skippedTests: TestTree[] = [];

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
  failedTests: TestTree[],
  skippedTests: TestTree[],
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
  succeededTests: TestTree[],
  failedTests: TestTree[],
  skippedTests: TestTree[],
  totalDurationInSec: number,
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
    `Total duration: ${Math.floor(totalDurationInSec / 60)} mins ` +
      `${Math.floor(totalDurationInSec % 60)} sec`,
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

type SuiteTree = ElementSuite & {
  children: (GroupTree | TestTree)[];
};

type GroupTree = ElementGroup & {
  parent?: GroupTree | SuiteTree;
  children: (GroupTree | TestTree)[];
};

type TestTree = ElementTestStart & {
  suite: SuiteTree;
  parent: GroupTree[];
  done?: ElementTestDone;
  print?: ElementPrint[];
  error?: ElementError[];
};

function buildTree(
  trees: Map<number, SuiteTree | GroupTree | TestTree>,
  element: Element,
) {
  switch (element.type) {
    case "start":
      break;

    case "suite": {
      const suiteTree: SuiteTree = {
        ...element,
        children: [],
      };
      trees.set(element.suite.id, suiteTree);
      break;
    }

    case "group": {
      const groupTree: GroupTree = {
        ...element,
        children: [],
      };
      trees.set(element.group.id, groupTree);
      if (element.group.parentID) {
        const parent = trees.get(element.group.parentID);
        if (parent?.type === "suite" || parent?.type === "group") {
          groupTree.parent = parent;
          parent.children.push(groupTree);
        }
      } else {
        const parent = trees.get(element.group.suiteID);
        if (parent?.type === "suite") {
          groupTree.parent = parent;
          parent.children.push(groupTree);
        }
      }
      break;
    }

    case "testStart": {
      const testTree: TestTree = {
        ...element,
        suite: trees.get(element.test.suiteID) as SuiteTree,
        parent: [],
      };
      trees.set(element.test.id, testTree);
      for (const groupID of element.test.groupIDs) {
        const group = trees.get(groupID);
        if (group?.type === "group") {
          testTree.parent.push(group);
        }
      }
      break;
    }

    case "testDone": {
      const testCandidate = trees.get(element.testID);
      if (testCandidate?.type === "testStart") {
        testCandidate.done = element;
      }
      break;
    }

    case "print": {
      const testCandidate = trees.get(element.testID);
      if (testCandidate?.type === "testStart") {
        testCandidate.print = testCandidate.print || [];
        testCandidate.print.push(element);
      }
      break;
    }

    case "error": {
      const testCandidate = trees.get(element.testID);
      if (testCandidate?.type === "testStart") {
        testCandidate.error = testCandidate.error
          ? [...testCandidate.error, element]
          : [element];
      }
      break;
    }

    case "allSuites":
      break;
  }
}

type Element =
  | ElementStart
  | ElementSuite
  | ElementTest
  | ElementGroup
  | ElementTestStart
  | ElementPrint
  | ElementTestDone
  | ElementAllSuites
  | ElementError
  | ElementDone;

type ElementStart = {
  type: "start";
  protocolVersion: string;
  runnerVersion: string;
  pid: number;
  time: number;
};

type ElementSuite = {
  type: "suite";
  suite: {
    id: number;
    platform: string;
    path: string;
  };
  time: number;
};

type ElementTestStart = {
  type: "testStart";
  test: {
    id: number;
    name: string;
    suiteID: number;
    groupIDs: number[];
    metadata: {
      skip: boolean;
      skipReason: null | string;
    };
    line: number | null;
    column: number | null;
    url: string | null;
    root_line?: number;
    root_column?: number;
    root_url?: string;
  };
  time: number;
};

type ElementAllSuites = {
  type: "allSuites";
  count: number;
  time: number;
};

type ElementTestDone = {
  type: "testDone";
  testID: number;
  result: "success" | "error" | "failure";
  skipped: boolean;
  hidden: boolean;
  time: number;
};

type ElementGroup = {
  type: "group";
  group: {
    id: number;
    suiteID: number;
    parentID: number | null;
    name: string;
    metadata: {
      skip: boolean;
      skipReason: null | string;
    };
    testCount: number;
    line: number | null;
    column: number | null;
    url: string | null;
  };
  time: number;
};

type ElementPrint = {
  type: "print";
  testID: number;
  messageType: "print";
  message: string;
  time: number;
};

type ElementTest = {
  type: "test";
  error?: string;
  stackTrace?: string;
  isFailure?: boolean;
};

type ElementError = {
  type: "error";
  testID: number;
  error: string;
  stackTrace: string;
  isFailure: boolean;
  time: number;
};

type ElementDone = {
  type: "done";
  success: boolean;
  time: number;
};

async function* readElements(filepath: string): AsyncGenerator<Element> {
  const file = await Deno.open(filepath);
  for await (
    const line of file.readable.pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream())
  ) {
    yield JSON.parse(line);
  }
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
async function getMelosProjectsWithTests(scopeArgs: string[]): Promise<
  { name: string; location: string }[]
> {
  try {
    // Run melos list command with --dir-exists=test to filter projects with test directories
    const projects = await $`melos list ${scopeArgs} --dir-exists=test --json`
      .noThrow()
      .json() as { name: string; location: string }[];
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
  const result = await $`melos list --json`.stdout("piped").noThrow();
  if (result.code !== 0) {
    Deno.exit(result.code);
  }

  const projects = JSON.parse(result.stdout) as {
    name: string;
    location: string;
  }[];
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

if (import.meta.main) {
  await main(Deno.args);
}

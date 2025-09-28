import { Command } from "@commander-js/extra-typings";
import { text } from "@lmstudio/lms-common";
import { type ModelInfo } from "@lmstudio/sdk";
import chalk from "chalk";
import columnify from "columnify";
import { architectureInfoLookup } from "../architectureStylizations.js";
import { addCreateClientOptions, createClient } from "../createClient.js";
import { formatSizeBytes1000 } from "../formatSizeBytes1000.js";
import { addLogLevelOptions, createLogger } from "../logLevel.js";
import { formatTimeLean } from "../formatElapsedTime.js";

function loadedCheck(count: number) {
  if (count === 0) {
    return "";
  } else if (count === 1) {
    return chalk.green("✓ LOADED");
  } else {
    return chalk.green(`✓ LOADED (${count})`);
  }
}

function architecture(architecture?: string) {
  if (architecture === undefined) {
    return "";
  }
  return architectureInfoLookup.find(architecture).name;
}

function printDownloadedModelsTable(
  title: string,
  downloadedModels: Array<ModelInfo>,
  loadedModels: Array<{ path: string; identifier: string }>,
) {
  const downloadedModelsAndHeadlines = downloadedModels
    .map(model => {
      return {
        path: model.modelKey,
        sizeBytes: formatSizeBytes1000(model.sizeBytes),
        params: model.paramsString,
        arch: architecture(model.architecture),
        loaded: loadedCheck(
          loadedModels.filter(loadedModel => loadedModel.path === model.path).length,
        ),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  console.info(
    columnify(downloadedModelsAndHeadlines, {
      columns: ["path", "params", "arch", "sizeBytes", "loaded"],
      config: {
        loaded: {
          headingTransform: () => "",
          align: "left",
        },
        path: {
          headingTransform: () => chalk.grey(title),
        },
        params: {
          headingTransform: () => chalk.grey("PARAMS"),
          align: "left",
        },
        arch: {
          headingTransform: () => chalk.grey("ARCH"),
          align: "left",
        },
        sizeBytes: {
          headingTransform: () => chalk.grey("SIZE"),
          align: "left",
        },
      },
      preserveNewLines: true,
      columnSplitter: "    ",
    }),
  );
}

export const ls = addCreateClientOptions(
  addLogLevelOptions(
    new Command()
      .name("ls")
      .description("List all downloaded models")
      .option("--llm", "Show only LLM models")
      .option("--embedding", "Show only embedding models")
      .option("--detailed", "[Deprecated] Show detailed view with grouping")
      .option("--json", "Outputs in JSON format to stdout"),
  ),
).action(async options => {
  const logger = createLogger(options);
  const client = await createClient(logger, options);

  const { llm = false, embedding = false, detailed = false, json = false } = options;

  let downloadedModels = await client.system.listDownloadedModels();
  const loadedModels = await client.llm.listLoaded();

  if (detailed) {
    logger.warn(
      chalk.yellow("The '--detailed' flag is deprecated. Output is the same as 'lms ls'"),
    );
  }

  const originalModelsCount = downloadedModels.length;

  if (llm || embedding) {
    const allowedTypes = new Set<string>();
    if (llm) {
      allowedTypes.add("llm");
    }
    if (embedding) {
      allowedTypes.add("embedding");
    }
    downloadedModels = downloadedModels.filter(model => allowedTypes.has(model.type));
  }

  const afterFilteringModelsCount = downloadedModels.length;

  if (json) {
    console.info(JSON.stringify(downloadedModels));
    return;
  }

  if (afterFilteringModelsCount === 0) {
    if (originalModelsCount === 0) {
      console.info(chalk.red("You have not downloaded any models yet."));
    } else {
      console.info(
        chalk.red(`You have ${originalModelsCount} models, but none of them match the filter.`),
      );
    }
    return;
  }

  let totalSizeBytes = 0;
  for (const model of downloadedModels) {
    totalSizeBytes += model.sizeBytes;
  }

  console.info();
  console.info(text`
    You have ${downloadedModels.length} models,
    taking up ${formatSizeBytes1000(totalSizeBytes)} of disk space.
  `);
  console.info();

  const llms = downloadedModels.filter(model => model.type === "llm");
  if (llms.length > 0) {
    printDownloadedModelsTable("LLM", llms, loadedModels);
    console.info();
  }

  const embeddings = downloadedModels.filter(model => model.type === "embedding");
  if (embeddings.length > 0) {
    printDownloadedModelsTable("EMBEDDING", embeddings, loadedModels);
    console.info();
  }
});

export const ps = addCreateClientOptions(
  addLogLevelOptions(
    new Command()
      .name("ps")
      .description("List all loaded models")
      .option("--json", "Outputs in JSON format to stdout"),
  ),
).action(async options => {
  const logger = createLogger(options);
  const client = await createClient(logger, options);

  const { json = false } = options;

  const loadedModels = [
    ...(await client.llm.listLoaded()),
    ...(await client.embedding.listLoaded()),
  ];

  if (json) {
    const modelInfos = await Promise.all(
      loadedModels.map(async model => {
        const info = await model.getModelInfo();
        const { instanceReference: _, ...filteredInfo } = info;
        const instanceProcessingState = await model.getInstanceProcessingState();
        return {
          ...filteredInfo,
          status: instanceProcessingState.status,
          queued: instanceProcessingState.queued,
        };
      }),
    );
    console.info(JSON.stringify(modelInfos));
    return;
  }

  if (loadedModels.length === 0) {
    logger.error(
      text`
        No models are currently loaded

        To load a model, run:

            ${chalk.yellow("lms load")}${"\n"}
      `,
    );
    return;
  }

  const loadedModelsWithInfo = await Promise.all(
    loadedModels.map(async loadedModel => {
      const { identifier } = loadedModel;
      const contextLength = await loadedModel.getContextLength();
      const modelInstanceInfo = await loadedModel.getModelInfo();
      const timeLeft =
        modelInstanceInfo.ttlMs !== null
          ? modelInstanceInfo.lastUsedTime === null
            ? modelInstanceInfo.ttlMs
            : modelInstanceInfo.ttlMs - (Date.now() - modelInstanceInfo.lastUsedTime)
          : undefined;

      const processingState = await loadedModel.getInstanceProcessingState();
      return {
        identifier,
        path: modelInstanceInfo.modelKey,
        sizeBytes: formatSizeBytes1000(modelInstanceInfo.sizeBytes),
        contextLength: contextLength,
        ttlMs:
          timeLeft !== undefined && modelInstanceInfo.ttlMs !== null
            ? `${formatTimeLean(timeLeft)} ${chalk.gray(`/ ${formatTimeLean(modelInstanceInfo.ttlMs)}`)}`
            : "",
        status: processingState.status.toUpperCase(),
      };
    }),
  );

  loadedModelsWithInfo.sort((a, b) => a.identifier.localeCompare(b.identifier));

  console.info();
  console.info(
    columnify(loadedModelsWithInfo, {
      columns: ["identifier", "path", "status", "sizeBytes", "contextLength", "ttlMs"],
      config: {
        identifier: {
          headingTransform: () => chalk.grey("IDENTIFIER"),
          align: "left",
        },
        path: {
          headingTransform: () => chalk.grey("MODEL"),
          align: "left",
        },
        status: {
          headingTransform: () => chalk.grey("STATUS"),
          align: "left",
        },
        sizeBytes: {
          headingTransform: () => chalk.grey("SIZE"),
          align: "left",
        },
        contextLength: {
          headingTransform: () => chalk.grey("CONTEXT"),
          align: "left",
        },
        ttlMs: {
          headingTransform: () => chalk.grey("TTL"),
          align: "left",
        },
      },
      preserveNewLines: true,
      columnSplitter: "    ",
    }),
  );
  console.info();
});

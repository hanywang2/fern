import { cwd, resolve } from "@fern-api/fs-utils";
import { initialize } from "@fern-api/init";
import { Language } from "@fern-api/ir-generator";
import { LogLevel, LOG_LEVELS } from "@fern-api/logger";
import { auth0Login, storeToken } from "@fern-api/login";
import {
    GENERATORS_CONFIGURATION_FILENAME,
    getFernDirectory,
    loadProjectConfig,
    PROJECT_CONFIG_FILENAME,
} from "@fern-api/project-configuration";
import { loadProject, Project } from "@fern-api/project-loader";
import { FernCliError } from "@fern-api/task-context";
import chalk from "chalk";
import getStdin from "get-stdin";
import { Argv } from "yargs";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { CliContext } from "./cli-context/CliContext";
import { getLatestVersionOfCli } from "./cli-context/upgrade-utils/getLatestVersionOfCli";
import { addGeneratorToWorkspaces } from "./commands/add-generator/addGeneratorToWorkspaces";
import { generateIrForWorkspaces } from "./commands/generate-ir/generateIrForWorkspaces";
import { generateWorkspaces } from "./commands/generate/generateWorkspaces";
import { validateAccessToken } from "./commands/login/validateAccessToken";
import { registerApiDefinitions } from "./commands/register/registerWorkspace";
import { upgrade } from "./commands/upgrade/upgrade";
import { validateWorkspaces } from "./commands/validate/validateWorkspaces";
import { TOKEN_STDIN_OPTION } from "./constants";
import { FERN_CWD_ENV_VAR } from "./cwd";
import { rerunFernCliAtVersion } from "./rerunFernCliAtVersion";

interface GlobalCliOptions {
    "log-level": LogLevel;
}

void runCli();

async function runCli() {
    const cliContext = new CliContext(process.stdout);

    const exit = async () => {
        await cliContext.exit();
    };
    process.on("SIGINT", async () => {
        cliContext.suppressUpgradeMessage();
        await exit();
    });

    try {
        const cwd = process.env[FERN_CWD_ENV_VAR];
        if (cwd != null) {
            process.chdir(cwd);
        }
        const versionOfCliToRun = await getIntendedVersionOfCli(cliContext);
        if (cliContext.environment.packageVersion === versionOfCliToRun) {
            await tryRunCli(cliContext);
        } else {
            await rerunFernCliAtVersion({
                version: versionOfCliToRun,
                cliContext,
            });
        }
    } catch (error) {
        if (error instanceof FernCliError) {
            // thrower is responsible for logging, so we generally don't need to log here.
            cliContext.failWithoutThrowing();
        } else {
            cliContext.failWithoutThrowing("Failed.", error);
        }
    }

    await exit();
}

async function tryRunCli(cliContext: CliContext) {
    const cli: Argv<GlobalCliOptions> = yargs(hideBin(process.argv))
        .scriptName(cliContext.environment.cliName)
        .version(false)
        .fail((message, error: unknown, argv) => {
            // if error is null, it's a yargs validation error
            if (error == null) {
                argv.showHelp();
                cliContext.logger.error(message);
            }
        })
        .strict()
        .exitProcess(false)
        .command(
            "$0",
            false,
            (yargs) =>
                yargs
                    .option("version", {
                        describe: "Print current version",
                        alias: "v",
                    })
                    .version(false),
            (argv) => {
                if (argv.version != null) {
                    cliContext.logger.info(cliContext.environment.packageVersion);
                } else {
                    cli.showHelp();
                    cliContext.failAndThrow();
                }
            }
        )
        .option("log-level", {
            default: LogLevel.Info,
            choices: LOG_LEVELS,
        })
        .demandCommand()
        .recommendCommands();

    addInitCommand(cli, cliContext);
    addAddCommand(cli, cliContext);
    addGenerateCommand(cli, cliContext);
    addIrCommand(cli, cliContext);
    addValidateCommand(cli, cliContext);
    addRegisterCommand(cli, cliContext);
    addLoginCommand(cli, cliContext);

    addUpgradeCommand({
        cli,
        cliContext,
        onRun: () => {
            cliContext.suppressUpgradeMessage();
        },
    });

    cli.middleware((argv) => {
        cliContext.setLogLevel(argv["log-level"]);
        cliContext.logDebugInfo();
    });

    await cli.parse();
}

async function getIntendedVersionOfCli(cliContext: CliContext): Promise<string> {
    const fernDirectory = await getFernDirectory();
    if (fernDirectory != null) {
        const projectConfig = await cliContext.runTask((context) =>
            loadProjectConfig({ directory: fernDirectory, context })
        );
        return projectConfig.version;
    }
    return getLatestVersionOfCli({ cliEnvironment: cliContext.environment });
}

function addInitCommand(cli: Argv<GlobalCliOptions>, cliContext: CliContext) {
    cli.command(
        "init",
        "Initialize a Fern API",
        (yargs) =>
            yargs.option("organization", {
                alias: "org",
                type: "string",
                description: "Organization name",
            }),
        async (argv) => {
            await cliContext.runTask(async (context) =>
                initialize({
                    organization: argv.organization,
                    versionOfCli: await getLatestVersionOfCli({ cliEnvironment: cliContext.environment }),
                    context,
                })
            );
        }
    );
}

function addAddCommand(cli: Argv<GlobalCliOptions>, cliContext: CliContext) {
    cli.command(
        "add <generator>",
        `Add a code generator to ${GENERATORS_CONFIGURATION_FILENAME}`,
        (yargs) =>
            yargs
                .positional("generator", {
                    type: "string",
                    demandOption: true,
                })
                .option("api", {
                    string: true,
                    description: "Only run the command on the provided API",
                }),
        async (argv) => {
            await addGeneratorToWorkspaces(
                await loadProjectAndRegisterWorkspacesWithContext(cliContext, {
                    commandLineWorkspace: argv.api,
                    defaultToAllWorkspaces: false,
                }),
                argv.generator,
                cliContext
            );
        }
    );
}

function addGenerateCommand(cli: Argv<GlobalCliOptions>, cliContext: CliContext) {
    cli.command(
        ["generate [group]"],
        "Generate all generators in the specified group",
        (yargs) =>
            yargs
                .positional("group", {
                    type: "string",
                    description: "The group to generate",
                })
                .option("version", {
                    type: "string",
                    description: "The version for the generated packages",
                })
                .option("api", {
                    string: true,
                    description: "Only run the command on the provided API",
                })
                .option("printZipUrl", {
                    boolean: true,
                    hidden: true,
                    default: false,
                }),
        async (argv) => {
            await generateWorkspaces({
                project: await loadProjectAndRegisterWorkspacesWithContext(cliContext, {
                    commandLineWorkspace: argv.api,
                    defaultToAllWorkspaces: false,
                }),
                cliContext,
                version: argv.version,
                groupName: argv.group,
                shouldLogS3Url: argv.printZipUrl,
            });
        }
    );
}

function addIrCommand(cli: Argv<GlobalCliOptions>, cliContext: CliContext) {
    cli.command(
        "ir <path-to-output>",
        false, // hide from help message
        (yargs) =>
            yargs
                .positional("path-to-output", {
                    type: "string",
                    description: "Path to write intermediate representation (IR)",
                    demandOption: true,
                })
                .option("api", {
                    string: true,
                    description: "Only run the command on the provided API",
                })
                .option("language", {
                    choices: Object.values(Language),
                    description: "Generate ir for a particular language",
                })
                .option("audience", {
                    type: "array",
                    string: true,
                    description: "Filter the ir for certain audiences",
                }),
        async (argv) => {
            await generateIrForWorkspaces({
                project: await loadProjectAndRegisterWorkspacesWithContext(cliContext, {
                    commandLineWorkspace: argv.api,
                    defaultToAllWorkspaces: false,
                }),
                irFilepath: resolve(cwd(), argv.pathToOutput),
                cliContext,
                generationLanguage: argv.language,
                audiences: argv.audience,
            });
        }
    );
}

function addRegisterCommand(cli: Argv<GlobalCliOptions>, cliContext: CliContext) {
    cli.command(
        ["register"],
        false, // hide from help message
        (yargs) =>
            yargs
                .option("version", {
                    type: "string",
                    description: "The version for the registered api",
                })
                .option("api", {
                    string: true,
                    description: "Only run the command on the provided API",
                }),
        async (argv) => {
            const project = await loadProjectAndRegisterWorkspacesWithContext(cliContext, {
                commandLineWorkspace: argv.api,
                defaultToAllWorkspaces: false,
            });
            if (project.token == null) {
                cliContext.failAndThrow("Please run fern login before registring.");
            }
            await registerApiDefinitions({
                project,
                cliContext,
                token: project.token,
                version: argv.version,
            });
        }
    );
}

function addValidateCommand(cli: Argv<GlobalCliOptions>, cliContext: CliContext) {
    cli.command(
        "check",
        "Validates your Fern Definition",
        (yargs) =>
            yargs.option("api", {
                string: true,
                description: "Only run the command on the provided API",
            }),
        async (argv) => {
            await validateWorkspaces({
                project: await loadProjectAndRegisterWorkspacesWithContext(cliContext, {
                    commandLineWorkspace: argv.api,
                    defaultToAllWorkspaces: true,
                }),
                cliContext,
            });
        }
    );
}

function addUpgradeCommand({
    cli,
    cliContext,
    onRun,
}: {
    cli: Argv<GlobalCliOptions>;
    cliContext: CliContext;
    onRun: () => void;
}) {
    cli.command(
        "upgrade",
        `Upgrades version in ${PROJECT_CONFIG_FILENAME}. Also upgrades generators in ${GENERATORS_CONFIGURATION_FILENAME} to their minimum-compatible versions.`,
        (yargs) =>
            yargs
                .option("rc", {
                    boolean: true,
                    hidden: true,
                    default: false,
                })
                .option("version", {
                    string: true,
                    description: "The version to upgrade to. Defaults to the latest release.",
                }),
        async (argv) => {
            await upgrade({
                cliContext,
                includePreReleases: argv.rc,
                targetVersion: argv.version,
            });
            onRun();
        }
    );
}

function addLoginCommand(cli: Argv<GlobalCliOptions>, cliContext: CliContext) {
    cli.command(
        "login",
        false, // hide from help message
        (yargs) =>
            yargs.option(TOKEN_STDIN_OPTION, {
                boolean: true,
                hidden: true,
                default: false,
            }),
        async (argv) => {
            let token;
            if (argv.tokenStdin) {
                token = (await getStdin()).replace(/\s/g, "");
                await validateAccessToken({ token, cliContext });
            } else {
                token = await auth0Login();
            }
            await storeToken(token);
            cliContext.logger.info(chalk.green("Logged in"));
        }
    );
}

async function loadProjectAndRegisterWorkspacesWithContext(
    cliContext: CliContext,
    args: Omit<loadProject.Args, "context" | "cliName" | "cliVersion">
): Promise<Project> {
    const context = cliContext.addTask().start();
    const project = await loadProject({
        ...args,
        cliName: cliContext.environment.cliName,
        cliVersion: cliContext.environment.packageVersion,
        context,
    });
    context.finish();

    cliContext.registerWorkspaces(project.workspaces);
    return project;
}

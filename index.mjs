#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import child_process from 'node:child_process';
import { JSONPath } from "jsonpath-plus";
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { createRequire } from 'node:module';
import chalk from 'chalk';

const require = createRequire(import.meta.url);

const BASE_PROCESS_FILE = `module.exports = [
    '$'
]
`

const MAX_FILENAME_TRIES = 100

let debounce
let abort = new AbortController()
const changes = new Set()

const config = yargs(hideBin(process.argv))
    .usage(`$0 input [options]`)
    .option('process', {
        alias: 'p',
        description: 'The location of the module describing how the data should be processed. If not provided, a new file will be automatically created.'
    })
    .option('output', {
        alias: 'o',
        description: 'Where to write the resulting data.'
    })
    .option('no-watch', {
        description: 'Run once and do not watch the input or process files.',
        default: false
    })
    .option('no-open', {
        alias: 'n',
        description: 'Do not open process (and output) file in editor on creation.',
        default: false
    })
    .boolean('no-watch')
    .boolean('no-open')
    .option('dir-depth', {
        description: 'How deep to expand the object tree when printing to console.',
        default: 5
    })
    .option('debounce', {
        default: 250,
        description: 'How long to wait after a write before starting processing, in milliseconds.'
    })
    .option('editor', {
        description: 'Path to an editor to use for editing and displaying files if $VISUAL and $EDITOR env variables are not defined.',
        default: 'code'
    })
    .demandCommand(1, 1, undefined, 'Provide a single input file')
    .parse();

const EDITOR = process.env.VISUAL ?? process.env.EDITOR ?? config.editor ?? 'code'

const inputFilePathFromOptions = config._[0];
const processFilePathFromOptions = config.process;
const outputFilePathFromOptions = config.output;
const dirDepth = config.dirDepth;

let data = await readFromFile(inputFilePathFromOptions);
let {processFilePath, processObj} = await loadOrCreateProcessFile(processFilePathFromOptions, inputFilePathFromOptions)

let processedData = await processDataUsingObj(data, processObj);
await outputProcessedData(processedData, dirDepth, outputFilePathFromOptions);

if (!config.noOpen && !(config.noWatch && processFilePathFromOptions)) {
    await openInEditor([processFilePath, outputFilePathFromOptions].filter(Boolean))
}

if (!config.noWatch) {
    await Promise.all([
        inputFilePathFromOptions ? setupWatcher(inputFilePathFromOptions, () => {
            changes.add('data')
            triggerProcess(processFilePath, inputFilePathFromOptions)
        }) : undefined,
        setupWatcher(processFilePath, () => {
            changes.add('process')
            triggerProcess(processFilePath, inputFilePathFromOptions)
        }),
    ]);
}

function triggerProcess(processFilePath, inputFilePath) {
    if (abort) abort.abort()
    clearTimeout(debounce)
    abort = new AbortController()
    const { signal } = abort
    debounce = setTimeout(() => {
        (async () => {
            signal.throwIfAborted()
            if (changes.has('data')) {
                changes.delete('data')
                data = await readFromFile(inputFilePathFromOptions);
            }
            signal.throwIfAborted()
            if (changes.has('process')) {
                changes.delete('process')
                const newProcess = await loadOrCreateProcessFile(processFilePath, inputFilePath);
                processObj = newProcess.processObj;
            }
            signal.throwIfAborted()
            processedData = await processDataUsingObj(data, processObj);
            signal.throwIfAborted()
            await outputProcessedData(processedData, dirDepth, outputFilePathFromOptions);
        })().catch((err) => {
            if (err.name === "AbortError") return;
            console.error(chalk.redBright(`[ERR]`) + ` ${err}`)
        })
    }, config.debounce)
}

async function setupWatcher(filePath, execute) {
    const fileWatcher = fs.watch(filePath);

    try {
        for await (const change of fileWatcher) {
            await execute()
        }
    } catch (err) {
        console.error(err);
        if (err.name === 'AbortError')
        throw new Error('Watch aborted');
    }
}

async function outputProcessedData(data, depth, outputPath) {
    if (outputPath) {
        await fs.writeFile(outputPath, JSON.stringify(data, undefined, 2), {
            encoding: 'utf8',
        })
        return
    }

    console.dir(data, {
        depth,
    });
    console.log("");
}

async function processDataUsingObj(data, processObj) {
    if (!Array.isArray(processObj)) {
        console.error(`Process needs to be an Array, found:\n\n${JSON.stringify(processObj, undefined, 2)}`)
        
        return data;
    }
    
    let currentStage = data;
    for (let i=0; i<processObj.length; i++) {
        const step = processObj[i];
        if (typeof step === 'string') {
            currentStage = JSONPath(step, currentStage)
        } else if (typeof step === 'function') {
            if (Array.isArray(currentStage)) {
                currentStage = currentStage.map(step)
            } else {
                currentStage = step(currentStage)
            }
        } else {
            throw new Error(`Unknown step at index ${i}: ${JSON.stringify(step)}`)
        }
    }

    return currentStage
}

async function openInEditor(files) {
    const fullExecString = `${EDITOR} ${files.map(file => (`"${file}"`)).join(' ')}`
    child_process.exec(fullExecString)
}

async function loadOrCreateProcessFile(processFilePath, inputFilePath) {
    if (!processFilePath) {
        const tempProcessFilePath = await findFreeFileName(inputFilePath ?? 'stdin', '.process', '.cjs')
        await fs.writeFile(tempProcessFilePath, BASE_PROCESS_FILE)
        processFilePath = tempProcessFilePath
    }

    try {
        await fs.access(processFilePath)
    } catch (error) {
        throw new Error(`Could not open process file: ${processFilePath}`)
    }

    const resolvedProcessFilePath = path.resolve(process.cwd(), processFilePath);
    delete require.cache[resolvedProcessFilePath];
    const processObj = require(resolvedProcessFilePath);

    return {processFilePath, processObj}
}

async function findFreeFileName(baseName, suffix, extension) {
    for (let i = 0; i < MAX_FILENAME_TRIES; i++) {
        let tryPath = `${baseName}${suffix}${i > 0 ? `-${i}` : ''}${extension}`
        try {
            await fs.stat(tryPath)
        } catch (e) {
            if (e.code === "ENOENT") return tryPath
        }
    }
    throw new Error(`Could not find an available filename, using base name: ${baseName}`)
}

async function readFromFile(filePath) {
    const dataBlob = await readFile(filePath);
    return await readData(dataBlob);
}

async function readFile(filePath) {
    return fs.readFile(filePath);
}

async function readData(dataBlob) {
    return JSON.parse(dataBlob)
}



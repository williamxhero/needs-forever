import { resolve } from 'node:path';
const normalized = (value) => value.replace(/\\+/g, '/').toLowerCase();
export const NATIVE_BINDING_COMMAND_HINT = 'For native binding, execute a single literal Node start/prepare/resume command directly, or a top-level await tools.exec_command({cmd: \"...\"}) optionally wrapped in text(...) or assigned to a result variable. Compound shell/JavaScript, dynamic strings and templates remain unbound; retry the supported direct command with resume --state FILE.';
// Deliberately accept only a single, literal Node invocation. Examples, shell
// pipelines, substitutions and compound scripts are not activation requests.
function shellWords(command) {
    const words = [];
    let word = '';
    let quote = '';
    let started = false;
    for (const character of command.trim()) {
        if (/[\r\n`$]/.test(character))
            return null;
        if (quote) {
            if (character === quote)
                quote = '';
            else
                word += character;
        }
        else if (character === '"' || character === "'") {
            quote = character;
            started = true;
        }
        else if (/\s/.test(character)) {
            if (started)
                words.push(word);
            word = '';
            started = false;
        }
        else if (character === '&' && words.length === 0 && !started)
            words.push('&');
        else if (/[;&|<>#()]/.test(character))
            return null;
        else {
            word += character;
            started = true;
        }
    }
    if (quote)
        return null;
    if (started)
        words.push(word);
    if (words[0] === '&')
        words.shift();
    return words;
}
// A small literal lexer, never eval. It rejects templates, expressions and
// unsupported syntax instead of finding commands inside arbitrary JS strings.
function codeTokens(code) {
    const tokens = [];
    let index = 0;
    while (index < code.length) {
        const rest = code.slice(index);
        const space = /^(?:\s+|\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)/.exec(rest);
        if (space) {
            index += space[0].length;
            continue;
        }
        const character = code[index];
        if (character === '"' || character === "'") {
            const quote = character;
            let value = '';
            index++;
            let closed = false;
            while (index < code.length) {
                const next = code[index++];
                if (next === quote) {
                    closed = true;
                    break;
                }
                if (next === '\n' || next === '\r')
                    return null;
                if (next !== '\\') {
                    value += next;
                    continue;
                }
                const escaped = code[index++];
                if (escaped === undefined)
                    return null;
                if (escaped === 'u' || escaped === 'x') {
                    const size = escaped === 'u' ? 4 : 2;
                    const hex = code.slice(index, index + size);
                    if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex))
                        return null;
                    value += String.fromCharCode(parseInt(hex, 16));
                    index += size;
                }
                else {
                    const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\\': '\\', '"': '"', "'": "'" };
                    if (!(escaped in escapes))
                        return null;
                    value += escapes[escaped];
                }
            }
            if (!closed)
                return null;
            tokens.push({ value: JSON.stringify(value), literal: value });
            continue;
        }
        const identifier = /^[A-Za-z_$][\w$]*/.exec(rest);
        if (identifier) {
            tokens.push({ value: identifier[0] });
            index += identifier[0].length;
            continue;
        }
        const number = /^-?\d+(?:\.\d+)?/.exec(rest);
        if (number) {
            tokens.push({ value: number[0] });
            index += number[0].length;
            continue;
        }
        if (!'{}[]():,;.=+'.includes(character))
            return null;
        tokens.push({ value: character });
        index++;
    }
    return tokens;
}
function codeCommand(code) {
    const tokens = codeTokens(code);
    if (!tokens)
        return null;
    let index = 0;
    const take = (value) => tokens[index]?.value === value ? (++index, true) : false;
    let wrapper = false;
    let resultName = null;
    if (take('text')) {
        if (!take('('))
            return null;
        wrapper = true;
    }
    else if (take('const')) {
        const name = tokens[index++];
        if (!name || ['tools', 'text', 'await', 'const', 'let', 'var', 'return', 'if', 'else', 'true', 'false', 'null', 'class', 'function', 'new', 'this', 'super', 'import', 'export', 'default', 'yield', 'delete', 'void', 'typeof', 'in', 'instanceof', 'try', 'catch', 'finally', 'throw', 'switch', 'case', 'break', 'continue', 'for', 'while', 'do', 'with', 'debugger', 'extends', 'enum', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'static'].includes(name.value) || name.literal !== undefined || !/^[A-Za-z_$][\w$]*$/.test(name.value) || !take('='))
            return null;
        resultName = name.value;
    }
    if (!take('await') || !take('tools') || !take('.') || !take('exec_command') || !take('(') || !take('{'))
        return null;
    const objectStart = index - 1;
    let depth = 1;
    while (index < tokens.length && depth > 0) {
        const token = tokens[index++];
        if (token.literal !== undefined)
            continue;
        if (token.value === '{')
            depth++;
        if (token.value === '}')
            depth--;
    }
    if (depth !== 0)
        return null;
    const objectTokens = tokens.slice(objectStart, index);
    // Unquoted keys are permitted; values must still be JSON literals.
    const json = objectTokens.map((token, position) => token.literal === undefined && /^[A-Za-z_$][\w$]*$/.test(token.value) && objectTokens[position + 1]?.value === ':' ? JSON.stringify(token.value) : token.value).join('');
    let options;
    try {
        options = JSON.parse(json);
    }
    catch {
        return null;
    }
    if (!take(')') || (wrapper && !take(')')))
        return null;
    take(';');
    if (resultName && index < tokens.length) {
        if (!take('text') || !take('(') || !take(resultName) || !take(')'))
            return null;
        take(';');
    }
    if (index !== tokens.length)
        return null;
    return typeof options.cmd === 'string' ? options.cmd : null;
}
/** Exact opt-in intent shared by the native adapter and receipt correlation. */
export function literalToolCommand(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
        return null;
    const value = input;
    return typeof value.code === 'string' ? codeCommand(value.code) : typeof value.cmd === 'string' ? value.cmd : typeof value.command === 'string' ? value.command : null;
}
export function controlIntent(input, pluginRoot) {
    const command = literalToolCommand(input);
    const words = command === null ? null : shellWords(command);
    if (!words || !['node', 'node.exe'].includes(normalized(words[0] ?? '').split('/').at(-1)))
        return null;
    const script = normalized(words[1] ?? '');
    const entry = script === normalized(resolve(pluginRoot, 'scripts/main-session.mjs')) ? 'main-session' : script === normalized(resolve(pluginRoot, 'scripts/control.mjs')) ? 'control' : null;
    const operation = words[2] === 'resume' ? 'resume' : words[2] === (entry === 'control' ? 'start' : 'prepare') ? 'prepare' : null;
    if (!entry || !operation)
        return null;
    const flags = Object.create(null);
    for (let index = 3; index < words.length; index += 2) {
        const key = words[index];
        const argument = words[index + 1];
        if (!['--task', '--state', '--test-fixture', '--control-mode'].includes(key) || !argument || key in flags)
            return null;
        flags[key] = argument;
    }
    if (flags['--control-mode'] && flags['--control-mode'] !== 'main-session')
        return null;
    if (operation === 'prepare' && !flags['--task'])
        return null;
    if ((entry === 'main-session' || operation === 'resume') && !flags['--state'])
        return null;
    return { entry, operation, flags };
}

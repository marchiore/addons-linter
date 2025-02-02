import ESLint from 'eslint';
import { oneLine } from 'common-tags';
import espree from 'espree';
import vk from 'eslint-visitor-keys';

import { ESLINT_RULE_MAPPING, ESLINT_TYPES } from 'const';
import * as messages from 'messages';
import { rules } from 'rules/javascript';
import { ensureFilenameExists } from 'utils';

const ECMA_VERSION = 2019;

export function excludeRules(excludeFrom = {}, excludeWhat = []) {
  return Object.keys(excludeFrom).reduce((result, ruleName) => {
    if (excludeWhat.includes(ruleName)) return result;
    return {
      ...result,
      [ruleName]: excludeFrom[ruleName],
    };
  }, {});
}

export default class JavaScriptScanner {
  _defaultRules = rules;

  disabledRules = [];

  constructor(code, filename, options = {}) {
    this.code = code;
    this.filename = filename;
    this.options = options;
    this.linterMessages = [];
    this.scannedFiles = [];
    this._rulesProcessed = 0;
    this.disabledRules =
      typeof options.disabledRules === 'string'
        ? options.disabledRules
            .split(',')
            .map((rule) => rule.trim())
            .filter((notEmptyRule) => notEmptyRule)
        : [];
    ensureFilenameExists(this.filename);
  }

  static get fileResultType() {
    return 'string';
  }

  static get scannerName() {
    return 'javascript';
  }

  async scan(
    _ESLint = ESLint,
    {
      _rules = this._defaultRules,
      _ruleMapping = ESLINT_RULE_MAPPING,
      _messages = messages,
    } = {}
  ) {
    this._ESLint = ESLint;
    this.sourceType = this.detectSourceType(this.filename);

    const configDefaults = {
      baseConfig: {
        env: {
          es6: true,
          webextension: true,
          browser: true,
        },
        settings: {
          addonMetadata: this.options.addonMetadata,
          existingFiles: this.options.existingFiles,
        },
      },
      // It's the default but also shouldn't change since we're using
      // espree to parse javascript files below manually to figure out
      // if they're modules or not
      parser: 'espree',
      parserOptions: {
        ecmaVersion: ECMA_VERSION,
        sourceType: this.sourceType,
      },
      rules: _ruleMapping,
      plugins: ['no-unsanitized'],
      allowInlineConfig: false,

      // Disable ignore-mode and overwrite eslint default ignore patterns
      // so an add-on's bower and node module folders are included in
      // the scan. See: https://github.com/mozilla/addons-linter/issues/1288
      ignore: false,
      patterns: ['!bower_components/*', '!node_modules/*'],
      // Also, don't ignore dotfiles in scans.
      dotfiles: true,

      filename: this.filename,

      // Avoid loading the addons-linter .eslintrc file
      useEslintrc: false,
    };

    const cli = new _ESLint.CLIEngine(configDefaults);

    const rulesAfterExclusion = excludeRules(_rules, this.disabledRules);
    Object.keys(rulesAfterExclusion).forEach((name) => {
      this._rulesProcessed++;
      cli.linter.defineRule(name, rulesAfterExclusion[name]);
    });

    // Parse and lint the JavaScript code
    const report = cli.executeOnText(this.code, this.filename, true);

    // eslint prepends the filename with the current working directory,
    // strip that out.
    this.scannedFiles.push(this.filename);

    report.results.forEach((result) => {
      result.messages.forEach((message) => {
        // Fatal error messages (like SyntaxErrors) are a bit different, we
        // need to handle them specially.
        if (message.fatal === true) {
          // eslint-disable-next-line no-param-reassign
          message.message = _messages.JS_SYNTAX_ERROR.code;
        }

        if (typeof message.message === 'undefined') {
          throw new Error(
            oneLine`JS rules must pass a valid message as
            the second argument to context.report()`
          );
        }

        // Fallback to looking up the message object by the message
        let code = message.message;
        let shortDescription;
        let description;

        // Support 3rd party eslint rules that don't have our internal
        // message structure and allow us to optionally overwrite
        // their `message` and `description`.
        if (Object.prototype.hasOwnProperty.call(_messages, code)) {
          ({ message: shortDescription, description } = _messages[code]);
        } else if (
          Object.prototype.hasOwnProperty.call(
            messages.ESLINT_OVERWRITE_MESSAGE,
            message.ruleId
          )
        ) {
          const overwrites = messages.ESLINT_OVERWRITE_MESSAGE[message.ruleId];
          shortDescription = overwrites.message || message.message;
          description = overwrites.description || message.description;

          if (overwrites.code) {
            ({ code } = overwrites);
          }
        } else {
          shortDescription = code;
          description = null;
        }

        this.linterMessages.push({
          code,
          column: message.column,
          description,
          file: this.filename,
          line: message.line,
          message: shortDescription,
          sourceCode: message.source,
          type: ESLINT_TYPES[message.severity],
        });
      });
    });

    return {
      linterMessages: this.linterMessages,
      scannedFiles: this.scannedFiles,
    };
  }

  _getSourceType(node) {
    const possibleImportExportTypes = [
      'ExportAllDeclaration',
      'ExportDefaultDeclaration',
      'ExportNamedDeclaration',
      'ExportSpecifier',
      'ImportDeclaration',
      'ImportDefaultSpecifier',
      'ImportNamespaceSpecifier',
      'ImportSpecifier',
    ];

    if (possibleImportExportTypes.includes(node.type)) {
      return 'module';
    }

    const keys = vk.KEYS[node.type];

    if (keys.length >= 1) {
      for (let i = 0; i < keys.length; ++i) {
        const child = node[keys[i]];

        if (Array.isArray(child)) {
          for (let j = 0; j < child.length; ++j) {
            if (this._getSourceType(child[j]) === 'module') {
              return 'module';
            }
          }
        } else {
          return this._getSourceType(child);
        }
      }
    }

    return 'script';
  }

  /*
    Analyze the source-code by by parsing the source code manually and
    check for import/export syntax errors.

    This returns `script` or `module`.
  */
  detectSourceType(filename) {
    // Default options taken from eslint/lib/linter:parse
    const parserOptions = {
      filePath: filename,
      sourceType: 'module',
      ecmaVersion: ECMA_VERSION,
    };

    let sourceType = 'module';

    try {
      const ast = espree.parse(this.code, parserOptions);
      sourceType = this._getSourceType(ast);
    } catch (exc) {
      sourceType = 'script';
    }

    return sourceType;
  }
}

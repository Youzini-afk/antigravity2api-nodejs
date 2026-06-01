import assert from 'node:assert/strict';
import { cleanParameters } from '../src/utils/utils.js';
import {
  convertOpenAIToolsToAntigravity,
  convertClaudeToolsToAntigravity,
  convertGeminiToolsToAntigravity
} from '../src/utils/toolConverter.js';
import { convertOpenAIToGeminiCli, convertGeminiToGeminiCli, convertClaudeToGeminiCli } from '../src/utils/converters/geminicli.js';

const ILLEGAL_SCHEMA_KEYS = new Set([
  '$schema', 'additionalProperties', 'deprecated', 'oneOf', 'allOf', 'anyOf',
  'default', 'format', 'title', 'example', 'propertyOrdering',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'
]);

function assertNoIllegalGeminiSchemaKeys(value, path = 'schema') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoIllegalGeminiSchemaKeys(item, `${path}[${index}]`));
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    assert(!key.startsWith('x-'), `${path} contains extension key ${key}`);
    assert(!ILLEGAL_SCHEMA_KEYS.has(key), `${path} contains illegal key ${key}`);
    assertNoIllegalGeminiSchemaKeys(nestedValue, `${path}.${key}`);
  }
}

function assertValidSanitizedParameters(parameters, path) {
  assertNoIllegalGeminiSchemaKeys(parameters, path);
  assert.equal(parameters.type, 'OBJECT');
  assert.equal(parameters.properties.Mode.type, 'STRING');
  assert.deepEqual(parameters.properties.Mode.enum, ['auto', 'always', 'never']);
  assert.match(parameters.properties.Mode.description, /auto - 自动判断/);
  assert.match(parameters.properties.Mode.description, /Default: auto/);
  assert.equal(parameters.properties.Count.type, 'INTEGER');
  assert.equal(parameters.properties.Count.nullable, true);
  assert.equal(parameters.properties.Count.minimum, 1);
  assert.equal(parameters.properties.Count.maximum, 5);
  assert.equal(parameters.properties.Nested.type, 'OBJECT');
  assert.deepEqual(parameters.properties.Nested.required, ['Enabled']);
  assert.equal(parameters.properties.Nested.properties.Enabled.type, 'BOOLEAN');
  assert.equal(parameters.properties.List.items.properties.ItemName.type, 'STRING');
  assert.equal(parameters.properties.UnknownType.type, 'STRING');
}

const opencodeLikeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  'x-google-identifier': 'RootSchema',
  properties: {
    Mode: {
      type: 'string',
      enum: ['auto', 'always', 'never'],
      'x-google-enum-descriptions': ['自动判断', '总是使用', '永不使用'],
      'x-google-enum-deprecated': [false, false, true],
      deprecated: false,
      default: 'auto'
    },
    Count: {
      type: ['integer', 'null'],
      minimum: 1,
      maximum: 5,
      oneOf: [
        { type: 'integer', minimum: 1 },
        { type: 'string', pattern: '^auto$' }
      ]
    },
    Nested: {
      allOf: [
        {
          type: 'object',
          properties: {
            Enabled: { type: 'boolean', 'x-google-identifier': 'EnabledFlag' }
          }
        },
        { required: ['Enabled'], description: 'Nested settings.' }
      ]
    },
    List: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ItemName: { type: 'string', pattern: '^item' }
        }
      }
    },
    UnknownType: {
      type: 'custom-type'
    }
  },
  required: ['Mode']
};

const cleaned = cleanParameters(opencodeLikeSchema);
assertValidSanitizedParameters(cleaned, 'cleaned');

const openaiTools = [{
  type: 'function',
  function: {
    name: 'tool.with spaces',
    description: 'test tool',
    parameters: opencodeLikeSchema
  }
}];

const antigravityTools = convertOpenAIToolsToAntigravity(openaiTools);
const antigravityParams = antigravityTools[0].functionDeclarations[0].parameters;
assertValidSanitizedParameters(antigravityParams, 'antigravityParams');
assert.equal(antigravityTools[0].functionDeclarations[0].name, 'tool_with_spaces');

const claudeTools = [{
  name: 'claude.tool',
  description: 'claude test tool',
  input_schema: opencodeLikeSchema
}];
const claudeParams = convertClaudeToolsToAntigravity(claudeTools)[0].functionDeclarations[0].parameters;
assertValidSanitizedParameters(claudeParams, 'claudeParams');

const geminiTools = [{
  function_declarations: [{
    name: 'gemini.tool',
    description: 'gemini test tool',
    parameters: opencodeLikeSchema
  }]
}];
const geminiParams = convertGeminiToolsToAntigravity(geminiTools)[0].functionDeclarations[0].parameters;
assertValidSanitizedParameters(geminiParams, 'geminiParams');

const opencodeJsonSchemaStringTool = [{
  name: 'json.schema.tool',
  description: 'json schema string test tool',
  jsonSchemaString: JSON.stringify(opencodeLikeSchema)
}];
const jsonSchemaParams = convertGeminiToolsToAntigravity(opencodeJsonSchemaStringTool)[0].functionDeclarations[0].parameters;
assertValidSanitizedParameters(jsonSchemaParams, 'jsonSchemaParams');

const geminiCliRequest = convertOpenAIToGeminiCli({
  model: 'gemini-2.5-pro',
  messages: [{ role: 'user', content: 'hello' }],
  tools: openaiTools
}).geminiRequest;
const geminiCliParams = geminiCliRequest.tools[0].functionDeclarations[0].parameters;
assertValidSanitizedParameters(geminiCliParams, 'geminiCliParams');

const nativeGeminiCliRequest = convertGeminiToGeminiCli({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  tools: geminiTools
}, 'gemini-2.5-pro').geminiRequest;
const nativeGeminiCliParams = nativeGeminiCliRequest.tools[0].functionDeclarations[0].parameters;
assertValidSanitizedParameters(nativeGeminiCliParams, 'nativeGeminiCliParams');

const claudeGeminiCliRequest = convertClaudeToGeminiCli({
  model: 'gemini-2.5-pro',
  messages: [{ role: 'user', content: 'hello' }],
  tools: claudeTools
}).geminiRequest;
const claudeGeminiCliParams = claudeGeminiCliRequest.tools[0].functionDeclarations[0].parameters;
assertValidSanitizedParameters(claudeGeminiCliParams, 'claudeGeminiCliParams');

console.log('✓ Gemini tool schema sanitizer test passed');

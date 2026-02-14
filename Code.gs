/**
 * Production-ready Gemini JSON client for Google Apps Script.
 *
 * Assumptions:
 * - The script is bound to a Google Workspace project with UrlFetchApp access.
 * - Secret API key is stored in Script Properties under GEMINI_API_KEY.
 * - Callers pass an object payload compatible with validateRequestPayload.
 */

var GeminiJsonService = (function () {
  'use strict';

  var CONFIG = {
    API_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
    MODEL: 'gemini-1.5-flash',
    PROPERTY_KEYS: {
      API_KEY: 'GEMINI_API_KEY',
      IDEMPOTENCY_NAMESPACE: 'IDEMPOTENCY_NS'
    },
    EXECUTION: {
      MAX_RUNTIME_MS: 5 * 60 * 1000,
      GUARD_BUFFER_MS: 20 * 1000
    },
    RETRY: {
      MAX_ATTEMPTS: 5,
      BASE_DELAY_MS: 500,
      MAX_DELAY_MS: 8000,
      JITTER_MS: 250
    },
    LLM: {
      TEMPERATURE: 0.1,
      TOP_P: 0.95,
      TOP_K: 20,
      MAX_OUTPUT_TOKENS: 512
    },
    IDEMPOTENCY: {
      TTL_SECONDS: 6 * 60 * 60
    }
  };

  function nowMs() {
    return new Date().getTime();
  }

  function makeContext(functionName) {
    return {
      functionName: functionName,
      startedAtMs: nowMs(),
      requestId: Utilities.getUuid()
    };
  }

  function logStructured(level, event, fields) {
    var payload = {
      level: level,
      event: event,
      ts: new Date().toISOString(),
      fields: fields || {}
    };
    console.log(JSON.stringify(payload));
  }

  function ensureTimeRemaining(context, minRemainingMs) {
    var elapsed = nowMs() - context.startedAtMs;
    var remaining = CONFIG.EXECUTION.MAX_RUNTIME_MS - elapsed;
    if (remaining < (minRemainingMs || CONFIG.EXECUTION.GUARD_BUFFER_MS)) {
      throw new Error('TIME_GUARD_TRIGGERED: remainingMs=' + remaining);
    }
    return remaining;
  }

  function getScriptProperty(key) {
    var value = PropertiesService.getScriptProperties().getProperty(key);
    if (!value) {
      throw new Error('Missing required script property: ' + key);
    }
    return value;
  }

  function validateRequestPayload(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('Invalid input: payload must be an object');
    }
    if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
      throw new Error('Invalid input: prompt must be a non-empty string');
    }

    var payload = {
      prompt: input.prompt.trim(),
      schema: input.schema,
      idempotencyKey: input.idempotencyKey || null,
      maxOutputTokens: input.maxOutputTokens || CONFIG.LLM.MAX_OUTPUT_TOKENS,
      temperature: typeof input.temperature === 'number' ? input.temperature : CONFIG.LLM.TEMPERATURE
    };

    if (payload.maxOutputTokens <= 0 || payload.maxOutputTokens > 2048) {
      throw new Error('Invalid input: maxOutputTokens must be between 1 and 2048');
    }
    if (payload.temperature < 0 || payload.temperature > 1) {
      throw new Error('Invalid input: temperature must be between 0 and 1');
    }
    if (!isPlainObject(payload.schema)) {
      throw new Error('Invalid input: schema must be a plain object');
    }

    return payload;
  }

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  function makeIdempotencyKey(payload) {
    if (payload.idempotencyKey) {
      return payload.idempotencyKey;
    }
    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      JSON.stringify({ prompt: payload.prompt, schema: payload.schema })
    );
    var key = Utilities.base64EncodeWebSafe(digest);
    return 'req:' + key;
  }

  function getCachedResult(idempotencyKey) {
    var cache = CacheService.getScriptCache();
    var hit = cache.get(idempotencyKey);
    if (!hit) {
      return null;
    }
    return JSON.parse(hit);
  }

  function setCachedResult(idempotencyKey, result) {
    var cache = CacheService.getScriptCache();
    cache.put(idempotencyKey, JSON.stringify(result), CONFIG.IDEMPOTENCY.TTL_SECONDS);
  }

  function sanitizeText(text) {
    if (typeof text !== 'string') {
      return '';
    }
    return text.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  }

  function tryParseStrictJson(rawText) {
    var cleaned = sanitizeText(rawText);
    if (!cleaned) {
      throw new Error('LLM response was empty after sanitization');
    }

    try {
      return JSON.parse(cleaned);
    } catch (directErr) {
      var extracted = extractFirstJsonObject(cleaned);
      if (!extracted) {
        throw new Error('Unable to parse JSON from LLM response: ' + directErr.message);
      }
      try {
        return JSON.parse(extracted);
      } catch (extractedErr) {
        throw new Error('Extracted JSON failed parsing: ' + extractedErr.message);
      }
    }
  }

  function extractFirstJsonObject(text) {
    var start = text.indexOf('{');
    if (start === -1) {
      return null;
    }

    var depth = 0;
    var inString = false;
    var escaped = false;

    for (var i = start; i < text.length; i += 1) {
      var ch = text.charAt(i);

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (!inString && ch === '{') {
        depth += 1;
      } else if (!inString && ch === '}') {
        depth -= 1;
        if (depth === 0) {
          return text.substring(start, i + 1);
        }
      }
    }

    return null;
  }

  function validateAgainstSchema(data, schema, path) {
    var currentPath = path || '$';

    if (!isPlainObject(schema)) {
      throw new Error('Schema error at ' + currentPath + ': expected object schema definition');
    }

    if (!schema.type) {
      throw new Error('Schema error at ' + currentPath + ': missing type');
    }

    if (schema.type === 'object') {
      if (!isPlainObject(data)) {
        throw new Error('Validation failed at ' + currentPath + ': expected object');
      }
      var props = schema.properties || {};
      var required = schema.required || [];

      for (var r = 0; r < required.length; r += 1) {
        if (!Object.prototype.hasOwnProperty.call(data, required[r])) {
          throw new Error('Validation failed at ' + currentPath + ': missing required field ' + required[r]);
        }
      }

      var keys = Object.keys(props);
      for (var k = 0; k < keys.length; k += 1) {
        var key = keys[k];
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          validateAgainstSchema(data[key], props[key], currentPath + '.' + key);
        }
      }
      return;
    }

    if (schema.type === 'array') {
      if (!Array.isArray(data)) {
        throw new Error('Validation failed at ' + currentPath + ': expected array');
      }
      if (schema.items) {
        for (var i = 0; i < data.length; i += 1) {
          validateAgainstSchema(data[i], schema.items, currentPath + '[' + i + ']');
        }
      }
      return;
    }

    if (schema.type === 'string' && typeof data !== 'string') {
      throw new Error('Validation failed at ' + currentPath + ': expected string');
    }
    if (schema.type === 'number' && typeof data !== 'number') {
      throw new Error('Validation failed at ' + currentPath + ': expected number');
    }
    if (schema.type === 'boolean' && typeof data !== 'boolean') {
      throw new Error('Validation failed at ' + currentPath + ': expected boolean');
    }
  }

  function buildPrompt(userPrompt, schema) {
    return [
      'You are a service that MUST output strict JSON only.',
      'No markdown, no prose, no code fences, no comments.',
      'Return only a single valid JSON object matching this schema:',
      JSON.stringify(schema),
      'Task:',
      userPrompt
    ].join('\n');
  }

  function sleepWithGuard(delayMs, context) {
    ensureTimeRemaining(context, delayMs + CONFIG.EXECUTION.GUARD_BUFFER_MS);
    Utilities.sleep(delayMs);
  }

  function shouldRetry(statusCode) {
    return statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
  }

  function backoffDelayMs(attempt) {
    var expo = CONFIG.RETRY.BASE_DELAY_MS * Math.pow(2, attempt - 1);
    var jitter = Math.floor(Math.random() * CONFIG.RETRY.JITTER_MS);
    return Math.min(expo + jitter, CONFIG.RETRY.MAX_DELAY_MS);
  }

  function callGeminiWithRetry(requestPayload, context) {
    var apiKey = getScriptProperty(CONFIG.PROPERTY_KEYS.API_KEY);
    var url = CONFIG.API_BASE_URL + '/models/' + CONFIG.MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);

    var body = {
      contents: [
        {
          parts: [{ text: requestPayload.prompt }]
        }
      ],
      generationConfig: {
        temperature: requestPayload.temperature,
        topP: CONFIG.LLM.TOP_P,
        topK: CONFIG.LLM.TOP_K,
        maxOutputTokens: requestPayload.maxOutputTokens,
        responseMimeType: 'application/json'
      }
    };

    var options = {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify(body)
    };

    for (var attempt = 1; attempt <= CONFIG.RETRY.MAX_ATTEMPTS; attempt += 1) {
      ensureTimeRemaining(context);
      var response;
      try {
        response = UrlFetchApp.fetch(url, options);
      } catch (fetchErr) {
        if (attempt === CONFIG.RETRY.MAX_ATTEMPTS) {
          throw new Error('URL fetch failed after retries: ' + fetchErr.message);
        }
        var transientDelay = backoffDelayMs(attempt);
        logStructured('WARN', 'llm_fetch_exception_retry', {
          requestId: context.requestId,
          attempt: attempt,
          delayMs: transientDelay,
          error: fetchErr.message
        });
        sleepWithGuard(transientDelay, context);
        continue;
      }

      var code = response.getResponseCode();
      var text = response.getContentText();

      if (code >= 200 && code < 300) {
        return text;
      }

      if (!shouldRetry(code) || attempt === CONFIG.RETRY.MAX_ATTEMPTS) {
        throw new Error('Gemini API error. code=' + code + ', body=' + sanitizeText(text));
      }

      var delay = backoffDelayMs(attempt);
      logStructured('WARN', 'llm_http_retry', {
        requestId: context.requestId,
        attempt: attempt,
        statusCode: code,
        delayMs: delay
      });
      sleepWithGuard(delay, context);
    }

    throw new Error('Unexpected retry termination');
  }

  function extractModelText(responseJson) {
    var candidates = responseJson && responseJson.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error('LLM response missing candidates');
    }

    var parts = candidates[0] && candidates[0].content && candidates[0].content.parts;
    if (!Array.isArray(parts) || parts.length === 0 || typeof parts[0].text !== 'string') {
      throw new Error('LLM response missing text content');
    }

    return parts[0].text;
  }

  function generateStructuredJson(input) {
    var context = makeContext('generateStructuredJson');
    var requestPayload = validateRequestPayload(input);
    var idempotencyKey = makeIdempotencyKey(requestPayload);

    logStructured('INFO', 'request_received', {
      requestId: context.requestId,
      idempotencyKey: idempotencyKey
    });

    var cached = getCachedResult(idempotencyKey);
    if (cached) {
      logStructured('INFO', 'idempotency_cache_hit', {
        requestId: context.requestId,
        idempotencyKey: idempotencyKey
      });
      return cached;
    }

    var strictPrompt = buildPrompt(requestPayload.prompt, requestPayload.schema);
    var rawApiText = callGeminiWithRetry(
      {
        prompt: strictPrompt,
        temperature: requestPayload.temperature,
        maxOutputTokens: requestPayload.maxOutputTokens
      },
      context
    );

    var apiJson;
    try {
      apiJson = JSON.parse(rawApiText);
    } catch (e) {
      throw new Error('Gemini response was not valid JSON envelope: ' + e.message);
    }

    var rawModelText = extractModelText(apiJson);
    var parsed = tryParseStrictJson(rawModelText);
    validateAgainstSchema(parsed, requestPayload.schema);

    var result = {
      requestId: context.requestId,
      idempotencyKey: idempotencyKey,
      output: parsed,
      generatedAt: new Date().toISOString()
    };

    setCachedResult(idempotencyKey, result);
    logStructured('INFO', 'request_completed', {
      requestId: context.requestId,
      idempotencyKey: idempotencyKey
    });

    return result;
  }

  return {
    generateStructuredJson: generateStructuredJson,
    validateAgainstSchema: validateAgainstSchema
  };
})();

function runGeminiJsonJob() {
  var schema = {
    type: 'object',
    required: ['summary', 'riskScore'],
    properties: {
      summary: { type: 'string' },
      riskScore: { type: 'number' }
    }
  };

  var result = GeminiJsonService.generateStructuredJson({
    prompt: 'Analyze: "Vendor outage in us-east-1 lasted 20 minutes" and provide summary + risk score 0-100.',
    schema: schema,
    idempotencyKey: 'vendor-outage-us-east-1-2024-01-01',
    maxOutputTokens: 200
  });

  console.log(JSON.stringify(result));
}

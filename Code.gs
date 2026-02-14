/**
 * Funding email extraction pipeline for Gmail + Gemini + Google Sheets.
 *
 * Required Script Properties:
 * - GEMINI_API_KEY: Gemini API key
 *
 * Optional Script Properties:
 * - GEMINI_MODEL: Override model id (default: gemini-1.5-flash)
 */
const CONFIG = {
  gmailLabelName: 'Funding/ToProcess',
  spreadsheetId: 'PUT_YOUR_SPREADSHEET_ID_HERE',
  sheetName: 'Funding Leads',
  maxThreadsPerRun: 20,
  maxMessagesPerThread: 3,
  geminiModelDefault: 'gemini-1.5-flash',
  geminiApiBase: 'https://generativelanguage.googleapis.com/v1beta/models',
  geminiRetries: 3,
  geminiRetryBaseDelayMs: 1000,
  interRequestDelayMs: 250,
  messageBodyMaxChars: 12000,
  processedMessageRetentionDays: 90,
  processedMessagePropertyPrefix: 'processed_msg_',
  headerRow: [
    'processed_at',
    'gmail_message_id',
    'gmail_thread_id',
    'subject',
    'from',
    'date',
    'grant_name',
    'sponsor',
    'amount',
    'deadline',
    'link',
    'notes'
  ]
};

/**
 * Main trigger function.
 * Time-driven trigger should call this function.
 */
function processFundingEmails() {
  const runId = Utilities.getUuid();
  const label = GmailApp.getUserLabelByName(CONFIG.gmailLabelName);
  if (!label) {
    logStructured_('ERROR', 'Configured Gmail label not found', {
      runId,
      label: CONFIG.gmailLabelName
    });
    return;
  }

  const properties = PropertiesService.getScriptProperties();
  const apiKey = properties.getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    logStructured_('ERROR', 'Missing GEMINI_API_KEY in Script Properties', { runId });
    return;
  }

  const model = properties.getProperty('GEMINI_MODEL') || CONFIG.geminiModelDefault;
  const threads = label.getThreads(0, CONFIG.maxThreadsPerRun);
  logStructured_('INFO', 'Starting funding email processing run', {
    runId,
    threadsFound: threads.length,
    maxThreadsPerRun: CONFIG.maxThreadsPerRun,
    model
  });

  let processedCount = 0;
  let skippedDuplicates = 0;
  let failures = 0;

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const threadId = thread.getId();
    let threadSuccess = true;

    try {
      const messages = thread.getMessages();
      const targetMessages = messages.slice(Math.max(0, messages.length - CONFIG.maxMessagesPerThread));

      for (let j = 0; j < targetMessages.length; j++) {
        const message = targetMessages[j];
        const messageId = message.getId();

        if (isMessageAlreadyProcessed_(messageId)) {
          skippedDuplicates++;
          logStructured_('INFO', 'Skipping duplicate message', { runId, threadId, messageId });
          continue;
        }

        const payload = buildGeminiExtractionPayload_(message);
        const extracted = requestFundingDataFromGemini_(payload, apiKey, model, runId, threadId, messageId);
        appendFundingRow_(message, extracted);
        markMessageProcessed_(messageId);
        processedCount++;

        Utilities.sleep(CONFIG.interRequestDelayMs);
      }

      if (threadSuccess) {
        thread.removeLabel(label);
        logStructured_('INFO', 'Removed processing label from thread', { runId, threadId });
      }
    } catch (error) {
      failures++;
      threadSuccess = false;
      logStructured_('ERROR', 'Thread processing failed; label retained for retry', {
        runId,
        threadId,
        errorMessage: String(error)
      });
    }
  }

  cleanupProcessedMessageMarkers_();

  logStructured_('INFO', 'Completed funding email processing run', {
    runId,
    processedCount,
    skippedDuplicates,
    failures
  });
}

/**
 * Calls Gemini API and returns validated structured funding info.
 */
function requestFundingDataFromGemini_(emailPayload, apiKey, model, runId, threadId, messageId) {
  const prompt = [
    'Extract funding opportunity information from the email below.',
    'Return STRICT JSON ONLY (no markdown, no code fences, no extra keys, no commentary).',
    'Required schema exactly:',
    '{',
    '  "grant_name": string|null,',
    '  "sponsor": string|null,',
    '  "amount": string|null,',
    '  "deadline": string|null,',
    '  "link": string|null,',
    '  "notes": string|null',
    '}',
    'Use null when a field is missing or uncertain.',
    '',
    'Email metadata:',
    JSON.stringify(emailPayload, null, 2)
  ].join('\n');

  const url = CONFIG.geminiApiBase + '/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);

  for (let attempt = 1; attempt <= CONFIG.geminiRetries; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        payload: JSON.stringify({
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json'
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }]
            }
          ]
        })
      });

      const statusCode = response.getResponseCode();
      const responseBody = response.getContentText();

      if (statusCode < 200 || statusCode >= 300) {
        const shouldRetry = statusCode === 429 || statusCode >= 500;
        logStructured_('WARN', 'Gemini HTTP error', {
          runId,
          threadId,
          messageId,
          attempt,
          statusCode,
          shouldRetry,
          responseBody: truncate_(responseBody, 1000)
        });

        if (shouldRetry && attempt < CONFIG.geminiRetries) {
          backoffSleep_(attempt);
          continue;
        }

        throw new Error('Gemini HTTP error: ' + statusCode + ' body=' + truncate_(responseBody, 500));
      }

      const json = JSON.parse(responseBody);
      const rawText = extractGeminiText_(json);
      const parsed = parseGeminiJsonStrict_(rawText);
      return normalizeFundingData_(parsed);
    } catch (error) {
      const isLastAttempt = attempt >= CONFIG.geminiRetries;
      logStructured_('WARN', 'Gemini attempt failed', {
        runId,
        threadId,
        messageId,
        attempt,
        isLastAttempt,
        errorMessage: String(error)
      });

      if (isLastAttempt) {
        throw new Error('Gemini extraction failed after retries: ' + String(error));
      }
      backoffSleep_(attempt);
    }
  }

  throw new Error('Unexpected retry loop exit');
}

/**
 * Appends one normalized funding row to the target sheet.
 */
function appendFundingRow_(message, fundingData) {
  const sheet = getOrCreateTargetSheet_();
  ensureHeaderRow_(sheet);

  const row = [
    new Date(),
    message.getId(),
    message.getThread().getId(),
    message.getSubject() || '',
    message.getFrom() || '',
    message.getDate() || '',
    fundingData.grant_name,
    fundingData.sponsor,
    fundingData.amount,
    fundingData.deadline,
    fundingData.link,
    fundingData.notes
  ];

  sheet.appendRow(row);
}

/**
 * Deduplication check: true when message has already been processed.
 */
function isMessageAlreadyProcessed_(messageId) {
  const key = CONFIG.processedMessagePropertyPrefix + messageId;
  return !!PropertiesService.getScriptProperties().getProperty(key);
}

/**
 * Deduplication mark to prevent reprocessing.
 */
function markMessageProcessed_(messageId) {
  const key = CONFIG.processedMessagePropertyPrefix + messageId;
  PropertiesService.getScriptProperties().setProperty(key, String(Date.now()));
}

/**
 * Removes old deduplication markers to keep property store bounded.
 */
function cleanupProcessedMessageMarkers_() {
  const maxAgeMs = CONFIG.processedMessageRetentionDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const toDelete = [];

  Object.keys(all).forEach(function(key) {
    if (key.indexOf(CONFIG.processedMessagePropertyPrefix) !== 0) {
      return;
    }
    const ts = Number(all[key]);
    if (!isFinite(ts) || ts < cutoff) {
      toDelete.push(key);
    }
  });

  if (toDelete.length) {
    toDelete.forEach(function(key) {
      props.deleteProperty(key);
    });
    logStructured_('INFO', 'Cleaned old dedup markers', { deletedCount: toDelete.length });
  }
}

/**
 * Extracts candidate JSON text from Gemini response structure.
 */
function extractGeminiText_(responseJson) {
  const candidates = responseJson && responseJson.candidates;
  if (!candidates || !candidates.length) {
    throw new Error('Gemini response missing candidates');
  }

  const parts = (((candidates[0] || {}).content || {}).parts || []);
  if (!parts.length || !parts[0].text) {
    throw new Error('Gemini response missing text part');
  }

  return parts[0].text;
}

/**
 * Strict JSON parsing with lightweight cleanup for accidental wrappers.
 */
function parseGeminiJsonStrict_(text) {
  const trimmed = String(text || '').trim();
  const cleaned = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error('Failed to parse Gemini JSON: ' + String(error) + ' raw=' + truncate_(cleaned, 500));
  }
}

/**
 * Enforces required schema and safely normalizes missing/invalid fields to null.
 */
function normalizeFundingData_(data) {
  const safe = {
    grant_name: null,
    sponsor: null,
    amount: null,
    deadline: null,
    link: null,
    notes: null
  };

  Object.keys(safe).forEach(function(key) {
    const value = data && Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    safe[key] = (typeof value === 'string' && value.trim() !== '') ? value.trim() : null;
  });

  return safe;
}

/**
 * Builds prompt-safe Gmail payload.
 */
function buildGeminiExtractionPayload_(message) {
  return {
    message_id: message.getId(),
    thread_id: message.getThread().getId(),
    date: message.getDate() ? message.getDate().toISOString() : null,
    from: message.getFrom() || null,
    to: message.getTo() || null,
    cc: message.getCc() || null,
    subject: message.getSubject() || null,
    body_plaintext: truncate_(message.getPlainBody() || '', CONFIG.messageBodyMaxChars)
  };
}

/**
 * Returns target sheet, creating it when necessary.
 */
function getOrCreateTargetSheet_() {
  const ss = SpreadsheetApp.openById(CONFIG.spreadsheetId);
  const sheet = ss.getSheetByName(CONFIG.sheetName);
  return sheet || ss.insertSheet(CONFIG.sheetName);
}

/**
 * Ensures header row exists and matches configured schema.
 */
function ensureHeaderRow_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(CONFIG.headerRow);
  }
}

/**
 * Exponential backoff helper.
 */
function backoffSleep_(attempt) {
  const delay = CONFIG.geminiRetryBaseDelayMs * Math.pow(2, attempt - 1);
  Utilities.sleep(delay);
}

/**
 * Structured logger helper.
 */
function logStructured_(level, message, context) {
  const payload = {
    severity: level,
    message,
    context: context || {},
    timestamp: new Date().toISOString()
  };
  console.log(JSON.stringify(payload));
}

function truncate_(value, maxLen) {
  const text = String(value || '');
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen) + '…';
}

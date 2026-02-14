# Gmail Funding Extraction Pipeline (Apps Script + Gemini)

## Setup
1. Create a Google Apps Script project bound to your target Google account.
2. Add `Code.gs` content from this repository.
3. Create a Google Sheet and copy its Spreadsheet ID.
4. Update `CONFIG.spreadsheetId` in `Code.gs`.
5. Create Gmail label `Funding/ToProcess` (or change `CONFIG.gmailLabelName`).
6. In Apps Script, open **Project Settings → Script properties** and set:
   - `GEMINI_API_KEY=YOUR_API_KEY`
   - Optional: `GEMINI_MODEL=gemini-1.5-flash`
7. Run `processFundingEmails` once manually and grant required permissions.

## Trigger Deployment
1. Open **Triggers** in Apps Script.
2. Add trigger:
   - Function: `processFundingEmails`
   - Event source: **Time-driven**
   - Type: e.g., **Every 5 minutes** (choose based on mailbox volume)
3. Save.

## Operational Notes
- Script reads up to `CONFIG.maxThreadsPerRun` labeled threads per run.
- Duplicate prevention uses `ScriptProperties` keys with prefix `processed_msg_`.
- Label is removed only after successful thread processing.
- Failed threads keep label for retry on next trigger run.
- Gemini calls include retry with exponential backoff.
- Output rows are appended to configured sheet with stable column order.

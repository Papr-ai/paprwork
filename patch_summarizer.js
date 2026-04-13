const fs = require('fs');
const path = require('path');
const p = '/Users/amirkabbara/Papr/jobs/8eea1893-4ca5-48ed-bfb4-187b9456fb31/job.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));

d.command = d.command.replace(
  'Step 1: Read all pending meetings:\nsqlite3 DB_PATH "SELECT id, title, transcript, notes FROM meetings WHERE status=\'pending\' AND transcript != \'\'"',
  'Step 1: Read all pending meetings and attendees:\nsqlite3 DB_PATH "SELECT m.id, m.title, m.transcript, m.notes, ce.attendees FROM meetings m LEFT JOIN calendar_events ce ON m.id = ce.meeting_id WHERE m.status=\'pending\' AND m.transcript != \'\'"\n\nIMPORTANT FOR DIARIZATION: The transcript contains \\"Speaker A\\", \\"Speaker B\\", etc. Use the `attendees` list and conversational context to infer who each speaker is. Use their REAL NAMES in the summary instead of generic speaker labels.'
);

fs.writeFileSync(p, JSON.stringify(d, null, 2));

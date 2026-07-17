import { AppError } from './errors.js';

const e164 = /^\+[1-9]\d{7,14}$/;

export function validateMessage(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }

  const required = ['client_ref', 'sender_id', 'channel', 'destination', 'text'];
  for (const field of required) {
    if (typeof input[field] !== 'string' || input[field].trim() === '') {
      throw new AppError(400, 'INVALID_FIELD', `${field} is required and must be a non-empty string.`, { field });
    }
  }
  if (input.channel !== 'sms') {
    throw new AppError(400, 'INVALID_CHANNEL', 'channel must be "sms".');
  }
  if (!e164.test(input.destination)) {
    throw new AppError(400, 'INVALID_DESTINATION', 'destination must be a valid E.164 phone number (for example +14155550100).');
  }
  if (input.text.trim().length === 0) {
    throw new AppError(400, 'INVALID_TEXT', 'text must not be empty.');
  }
  if (input.text.length > 1600) {
    throw new AppError(400, 'INVALID_TEXT', 'text must be 1600 characters or fewer.');
  }
  return {
    client_ref: input.client_ref.trim(),
    sender_id: input.sender_id.trim(),
    channel: input.channel,
    destination: input.destination,
    text: input.text
  };
}

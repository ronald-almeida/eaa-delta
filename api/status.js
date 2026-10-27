import { handle } from '../lib/payments.js';
export default function handler(req, res) { return handle(req, res, 'status'); }

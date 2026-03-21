import { Router } from 'express';
import pkg from '../../package.json' with { type: 'json' };

export const version = pkg.version ?? 'unknown';

export function handleGetInfo(_req, res, next) {
	try {
		res.json({ version });
	}
	catch (err) {
		next(err);
	}
}

export const infoRouter = Router();
infoRouter.get('/', handleGetInfo);

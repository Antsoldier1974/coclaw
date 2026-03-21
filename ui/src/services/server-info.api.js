import { httpClient as client } from './http.js';

export async function fetchServerInfo() {
	const res = await client.get('/api/v1/info');
	return res.data;
}

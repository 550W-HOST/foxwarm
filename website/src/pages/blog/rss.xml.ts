import type { APIRoute } from 'astro';
import { blogFeed } from '../../blog/feed';

export const GET: APIRoute = () => blogFeed('en');

/** lolPing runs on Windows. Shared code takes this instead of reading process.platform. */
export type Platform = 'win';

export const platformOf = (_nodePlatform: string): Platform => 'win';

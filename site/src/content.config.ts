import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { experienceEntrySchema, photoSchema } from './content/schema';

const experience = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/experience' }),
  schema: experienceEntrySchema,
});

const photos = defineCollection({
  loader: glob({ pattern: '**/*.yaml', base: './src/content/photos' }),
  schema: photoSchema,
});

export const collections = { experience, photos };

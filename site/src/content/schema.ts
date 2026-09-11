import { z } from 'zod';

export const projectSchema = z.object({
  demoUrl: z.string().url().optional(),
  description: z.string(),
  githubUrl: z.string().url(),
  order: z.number().default(0),
  tags: z.array(z.string()),
  title: z.string(),
});

export type Project = z.infer<typeof projectSchema>;

export const photoObjectSchema = z.discriminatedUnion('object_type', [
  z.object({
    details: z.object({
      description: z.string(),
    }),
    object_type: z.literal('landmark'),
  }),
  z.object({
    details: z.object({
      common_name: z.string(),
      description: z.string().nullable(),
      scientific_name: z.string(),
    }),
    object_type: z.literal('organism'),
  }),
]);

export const photoSchema = z.object({
  date: z.coerce.date(),
  file: z.string(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  notes: z.string().nullish(),
  objects: z.array(photoObjectSchema).min(1),
  slug: z.string(),
  tier: z.enum(['S', 'A', 'B', 'C', 'D', 'E', 'F']),
});

export type Photo = z.infer<typeof photoSchema>;
export type PhotoObject = z.infer<typeof photoObjectSchema>;

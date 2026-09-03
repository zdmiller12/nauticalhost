import { z } from 'zod';

export const projectSchema = z.object({
  title: z.string(),
  description: z.string(),
  githubUrl: z.string().url(),
  demoUrl: z.string().url().optional(),
  tags: z.array(z.string()),
  order: z.number().default(0),
});

export type Project = z.infer<typeof projectSchema>;

export const photoObjectSchema = z.discriminatedUnion('object_type', [
  z.object({
    object_type: z.literal('landmark'),
    details: z.object({
      description: z.string(),
    }),
  }),
  z.object({
    object_type: z.literal('organism'),
    details: z.object({
      common_name: z.string(),
      scientific_name: z.string(),
      description: z.string().nullable(),
    }),
  }),
]);

export const photoSchema = z.object({
  slug: z.string(),
  file: z.string(),
  date: z.coerce.date(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  camera: z.string().min(1),
  lens: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  objects: z.array(photoObjectSchema).min(1),
  notes: z.string().nullish(),
});

export type Photo = z.infer<typeof photoSchema>;
export type PhotoObject = z.infer<typeof photoObjectSchema>;

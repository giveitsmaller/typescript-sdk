/**
 * Regression guard (routed from frontend 2026-06-26): the
 * `GET /api/operations/schema` deserialization (`getSchema`) MUST apply the
 * `default` -> `_default` reserved-word rename — and the `depends_on` ->
 * `dependsOn` camelize — through the FULL nested option path
 * (`OperationsSchemaResponse` -> `OperationSchemaDefinition` ->
 * `mime_groups`/`options` -> `OptionSchema`).
 *
 * openapi-generator emits this rename today (`OptionSchemaFromJSONTyped` maps
 * `json['default']` -> `_default`, and every options map is routed through
 * `OptionSchemaFromJSON` via `mapValues`). If a future regen ever drops it, the
 * SDK would silently expose a raw `default` key consumers don't read — which is
 * exactly the class of bug the frontend hit (no option defaults -> broken
 * thumbnail background-colour picker + JPG quality default seeding). This test
 * pins the behaviour so that regression fails CI.
 */
import { describe, it, expect } from 'vitest';
import {
  OptionSchemaFromJSON,
  OperationsSchemaResponseFromJSON,
} from '@giveitsmaller/contracts/openapi';

describe('getSchema deserialization — default -> _default reserved-word rename', () => {
  it('OptionSchemaFromJSON renames `default` -> `_default` and `depends_on` -> `dependsOn`', () => {
    const out = OptionSchemaFromJSON({
      type: 'string',
      default: '#ffffff',
      depends_on: { format: ['jpeg'] },
    });
    expect(out._default).toBe('#ffffff');
    expect('default' in out).toBe(false);
    expect(out.dependsOn).toEqual({ format: ['jpeg'] });
    expect('depends_on' in out).toBe(false);
  });

  it('the full OperationsSchemaResponse path carries the rename to every nested option', () => {
    const raw = {
      operations: {
        thumbnail: {
          availability: 'stable',
          input_model: { mode: 'single' },
          mime_groups: {
            'image/jpeg': {
              mimes: ['image/jpeg'],
              options: {
                background: {
                  type: 'string',
                  default: '#ffffff',
                  depends_on: { format: ['jpeg'] },
                },
                quality: { type: 'integer', default: 80 },
              },
            },
          },
        },
      },
    };
    const out = OperationsSchemaResponseFromJSON(raw);
    const opts = out.operations['thumbnail']!.mimeGroups!['image/jpeg']!.options;

    const background = opts['background']!;
    expect(background._default).toBe('#ffffff');
    expect('default' in background).toBe(false);
    expect(background.dependsOn).toEqual({ format: ['jpeg'] });

    expect(opts['quality']!._default).toBe(80);
  });
});

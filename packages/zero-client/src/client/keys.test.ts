import fc from 'fast-check';
import {expect, test} from 'vitest';
import type {PrimaryKey} from '../../../zero-protocol/src/primary-key.js';
import {toPrimaryKeyString} from './keys.js';

test('toPrimaryKeyString', () => {
  expect(
    toPrimaryKeyString('issue', ['id'], {id: 'issue1'}),
  ).toMatchInlineSnapshot(`"e/issue/issue1"`);

  expect(
    toPrimaryKeyString('issue_label', ['issueID', 'labelID'], {
      issueID: 'issue1',
      labelID: 'label1',
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/dqncq7kzfa6fpmhj26azwoy9t"`);
  expect(
    toPrimaryKeyString('issue_label', ['issueID', 'labelID'], {
      labelID: 'label1',
      issueID: 'issue1',
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/dqncq7kzfa6fpmhj26azwoy9t"`);

  // Order of the primary key fields does not matter.
  expect(
    toPrimaryKeyString('issue_label', ['labelID', 'issueID'], {
      issueID: 'issue1',
      labelID: 'label1',
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/dqncq7kzfa6fpmhj26azwoy9t"`);

  // Extra columns are ignored
  expect(
    toPrimaryKeyString('issue_label', ['issueID', 'labelID'], {
      labelID: 'label1',
      issueID: 'issue1',
      more: 'data',
      ignore: 'bananas',
      me: true,
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/dqncq7kzfa6fpmhj26azwoy9t"`);

  // Numeric value in the primary key.
  expect(
    toPrimaryKeyString('issue_label', ['id'], {
      id: Math.PI,
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/3.141592653589793"`);

  // 1 is same as '1' but that's okay because the scheme should not allow
  // incorrect types at a higher level.
  expect(
    toPrimaryKeyString('issue_label', ['id'], {
      id: 1,
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/1"`);
  expect(
    toPrimaryKeyString('issue_label', ['id'], {
      id: '1',
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/1"`);

  // Boolean value in the primary key.
  expect(
    toPrimaryKeyString('issue_label', ['id'], {
      id: true,
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/true"`);
  expect(
    toPrimaryKeyString('issue_label', ['id'], {
      id: false,
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/false"`);

  // true is same as 'true' but that's okay because the schema should not allow
  // incorrect types at a higher level.
  expect(
    toPrimaryKeyString('issue_label', ['id'], {
      id: 'true',
    }),
  ).toMatchInlineSnapshot(`"e/issue_label/true"`);
});

test('no clashes - single pk', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.tuple(fc.string(), fc.string()),
        fc.tuple(fc.double(), fc.double()),
        fc.tuple(fc.boolean(), fc.boolean()),
      ),
      ([a, b]) => {
        const keyA = toPrimaryKeyString('issue', ['id'], {id: a});
        const keyB = toPrimaryKeyString('issue', ['id'], {id: b});
        if (a === b) {
          expect(keyA).toBe(keyB);
        } else {
          expect(keyA).not.toBe(keyB);
        }
      },
    ),
  );
});

test('no clashes - multiple pk', () => {
  const primaryKey: PrimaryKey = ['id', 'name'];
  fc.assert(
    fc.property(
      fc.tuple(
        fc.oneof(fc.string(), fc.double(), fc.boolean()),
        fc.oneof(fc.string(), fc.double(), fc.boolean()),
        fc.oneof(fc.string(), fc.double(), fc.boolean()),
        fc.oneof(fc.string(), fc.double(), fc.boolean()),
      ),
      ([a1, a2, b1, b2]) => {
        const keyA = toPrimaryKeyString('issue', primaryKey, {
          id: a1,
          name: a2,
        });
        const keyB = toPrimaryKeyString('issue', primaryKey, {
          id: b1,
          name: b2,
        });
        if (a1 === b1 && a2 === b2) {
          expect(keyA).toBe(keyB);
        } else {
          expect(keyA).not.toBe(keyB);
        }
      },
    ),
  );
});

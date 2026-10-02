const assert = require('assert');

const {
    createMetaFormat,
    setMetaFormat,
    validateMeta,
} = require('../../../../src/actions/list/meta.js');

describe('LIST meta part', function(){
    describe('format specs', function(){
        it('defines create metadata format 4 with ITEM at field 5', function(){
            const spec = createMetaFormat.call({});
            const fields = spec.fields.split('|');

            assert.deepStrictEqual(spec, {
                format: 4,
                fields: 'VERSION|TYPE|NAME|DESCRIPTION|MEMO|ITEM',
                gate: 'list_meta_activation.LIST_META_ACTIVATION',
            });
            assert.strictEqual(fields.indexOf('ITEM'), 5);
        });

        it('defines set metadata format 5 without ITEM', function(){
            const spec = setMetaFormat.call({});

            assert.deepStrictEqual(spec, {
                format: 5,
                fields: 'VERSION|LIST_ACTION_INDEX|NAME|DESCRIPTION|MEMO',
                gate: 'list_meta_activation.LIST_META_ACTIVATION',
            });
            assert.strictEqual(spec.fields.split('|').includes('ITEM'), false);
        });
    });

    describe('validateMeta', function(){
        it('reports every NAME verdict in field-rule order', function(){
            const cases = [
                [7, 'invalid: NAME (format)'],
                ['a|b', 'invalid: NAME (pipe)'],
                ['a;b', 'invalid: NAME (semicolon)'],
                ['a'.repeat(65), 'invalid: NAME (length)'],
                ['\u202Ename', 'invalid: NAME (format)'],
            ];

            for(const [name, verdict] of cases)
                assert.strictEqual(validateMeta.call({}, {
                    NAME: name,
                    DESCRIPTION: 'Description',
                }, 5, null), verdict);
        });

        it('reports every DESCRIPTION verdict in field-rule order', function(){
            const cases = [
                [7, 'invalid: DESCRIPTION (format)'],
                ['a|b', 'invalid: DESCRIPTION (pipe)'],
                ['a;b', 'invalid: DESCRIPTION (semicolon)'],
                ['a'.repeat(513), 'invalid: DESCRIPTION (length)'],
                ['a\nb', 'invalid: DESCRIPTION (format)'],
            ];

            for(const [description, verdict] of cases)
                assert.strictEqual(validateMeta.call({}, {
                    NAME: 'Name',
                    DESCRIPTION: description,
                }, 5, null), verdict);
        });

        it('checks NAME before DESCRIPTION', function(){
            assert.strictEqual(validateMeta.call({}, {
                NAME: 'a|b',
                DESCRIPTION: 'a;b',
            }, 4, null), 'invalid: NAME (pipe)');
        });

        it('refuses clear sentinels on create and accepts them on set', function(){
            assert.strictEqual(validateMeta.call({}, {
                NAME: '-',
                DESCRIPTION: '-',
            }, 4, null), 'invalid: NAME (format)');
            assert.strictEqual(validateMeta.call({}, {
                NAME: '-',
                DESCRIPTION: '-',
            }, 5, null), null);
        });

        it('accepts empty create metadata and refuses an empty set', function(){
            assert.strictEqual(validateMeta.call({}, {
                NAME: '',
                DESCRIPTION: '',
            }, 4, null), null);
            assert.strictEqual(validateMeta.call({}, {
                NAME: '',
                DESCRIPTION: '',
            }, 5, null), 'invalid: NAME (no change)');
        });

        it('passes through an earlier error unchanged', function(){
            const earlier = { verdict: 'invalid: earlier' };

            assert.strictEqual(validateMeta.call({}, {
                NAME: 'a|b',
                DESCRIPTION: 'a;b',
            }, 4, earlier), earlier);
        });

        it('leaves format 0 untouched', function(){
            assert.strictEqual(validateMeta.call({}, {
                NAME: 'a|b',
                DESCRIPTION: 'a;b',
            }, 0, null), null);
        });
    });
});

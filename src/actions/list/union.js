'use strict';

const gateRegistry = require('../../consensus/gate_registry');
const protocolConstants = require('../../protocol/constants.js');
const {
    canonicalMemberIndex,
    unionResultVerdict,
    memberTypeVerdict,
    storedTypeVerdict,
} = require('./union_rules.js');
const {
    isValidListRoot,
    getUnionMemberRoots,
    getUnionMemberType,
} = require('../../db/lists/membership.js');

const UNION_GATE = 'list_union_activation.LIST_UNION_ACTIVATION';
const LIST_UNION_MAX_MEMBERS = protocolConstants.LIST_UNION_MAX_MEMBERS || 16;
const LIST_SHARE_MAX_MEMBERS = protocolConstants.LIST_SHARE_MAX_MEMBERS || 10000;

module.exports = {
    unionTypeActive(data){
        if(typeof this.indexerDb.getListStoredType !== 'function')
            return false;
        try {
            return gateRegistry.activeAt(
                UNION_GATE,
                this.config['NETWORK'],
                this.config['COIN'],
                data['BLOCK_INDEX'],
                null
            );
        } catch(error){
            if(error && error.name === 'RegistryMissError')
                return false;
            throw error;
        }
    },

    async loadUnionMembers(data){
        let headIndex = await this.indexerDb.getListHeadIndex(
            data['LIST_ACTION_INDEX'],
            data['BLOCK_INDEX']
        );
        return getUnionMemberRoots(this.indexerDb, headIndex);
    },

    async checkUnionItem(item, data){
        let memberIndex = canonicalMemberIndex(item);
        if(memberIndex === null)
            return { item, status: 'invalid: LIST (unknown)' };

        let getStoredType = this.indexerDb.getListStoredType || this.indexerDb.getListType;
        let storedType = await getStoredType.call(
            this.indexerDb,
            memberIndex,
            data['BLOCK_INDEX']
        );
        if(storedType === false)
            return { item, status: 'invalid: LIST (unknown)' };

        let root = await this.indexerDb.getListRootIndex(memberIndex);
        if(!await isValidListRoot(this.indexerDb, root))
            return { item, status: 'invalid: LIST (unknown)' };

        let status = storedTypeVerdict(storedType);
        if(status)
            return { item: String(root), status };

        let unionMemberType;
        if(data['FORMAT']==0){
            if(data['UNION_MEMBER_TYPE'] === undefined)
                data['UNION_MEMBER_TYPE'] = storedType;
            unionMemberType = data['UNION_MEMBER_TYPE'];
        } else {
            if(data['UNION_MEMBER_TYPE'] === undefined)
                data['UNION_MEMBER_TYPE'] = await getUnionMemberType(
                    this.indexerDb,
                    data['LIST_ACTION_INDEX']
                );
            unionMemberType = data['UNION_MEMBER_TYPE'];
        }

        status = memberTypeVerdict(storedType, unionMemberType);
        return { item: String(root), status: status || 'valid' };
    },

    async validateUnionResult(data, format, list, changes, error){
        if(error || data['TYPE']!=3)
            return error;

        let merged = new Set();
        if(!data['IS_GENESIS']){
            for(let member of list){
                let items = await this.indexerDb.getList(member, data['BLOCK_INDEX']);
                for(let item of items)
                    merged.add(item);
            }
        }

        return unionResultVerdict({
            isCreate: format==0,
            memberCount: list.length,
            mergedCount: merged.size,
        }, {
            unionMax: LIST_UNION_MAX_MEMBERS,
            shareMax: LIST_SHARE_MAX_MEMBERS,
        });
    },
};

--********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md. A commercial
-- license (without AGPL source-disclosure terms) is available -
-- contact legal@dankest.llc.
--
--********************************************************************

-- Extra SQL queries to fake transactions which do not exist on the blockchain

-- -- Address 99570 1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev

-- -- Create transaction hash and transaction (example)
-- INSERT INTO index_transactions (id, hash) values (5423216, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a9c');
-- INSERT INTO transactions (tx_index, tx_hash_id, block_index, source_id, data) values (75351, 5423216, 862605, 99570 , 'BATCH|0|MINT|0|GAS|60;ISSUE|0|JDOGTEST');

-- -- Create callback and reward tokens (non-divisible)
-- ISSUE|0|CBTEST1|100||0|Callback Token 
-- ISSUE|0|CBTEST2|100||0|Callback Reward Token

-- -- Update callback token with reward info
-- ISSUE|4|CBTEST1|862200|CBTEST2|1

-- -- Send callback token to a few users
-- SEND|1|CBTEST1|1|17YCEZgooP2jJ1gPM6ffKzBLkhxreuLJS8|2|12a9KsYiLg3nHNpKTbQ9oJ3dxHK3kL4tnS|3|bc1q0u35a3x3ee692myk7gjx3f57rxzthsxa72p28u|Sending callback token

-- -- Callback Token and hand out reward token
-- CALLBACK|0|CBTEST1|Callback on CBTEST1

-- -- ISSUE
-- VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_RUG|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY

-- -- ISSUE - Callback Info
-- VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT

-- -- Send (Multiple)
-- VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO

-- -- CALLBACK
-- VERSION|TICK|MEMO

DELETE FROM index_transactions where id>=5423217;
DELETE FROM transactions where tx_hash_id>=5423217;
DELETE FROM transactions where block_index>=862600;

INSERT INTO index_transactions (id, hash) values (60000000, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e00001');
INSERT INTO index_transactions (id, hash) values (60000001, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e00002');
INSERT INTO index_transactions (id, hash) values (60000002, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e00003');
INSERT INTO index_transactions (id, hash) values (60000003, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e00004');
INSERT INTO index_transactions (id, hash) values (60000004, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e00005');
INSERT INTO index_transactions (id, hash) values (60000005, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e00006');
INSERT INTO index_transactions (id, hash) values (60000006, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e00007');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(60000000, 862600, 99570, 'MINT|0|GAS|60');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(60000001, 862600, 99570, 'MINT|0|GAS|60');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(60000002, 862600, 99570, 'MINT|0|GAS|60');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(60000003, 862600, 99570, 'MINT|0|GAS|60');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(60000004, 862600, 99570, 'MINT|0|GAS|60');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(60000005, 862600, 99570, 'MINT|0|GAS|60');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(60000006, 862600, 99570, 'MINT|0|GAS|60');


-- Create callback and reward tokens (non-divisible)
INSERT INTO index_transactions (id, hash) values (5423217, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a01');
INSERT INTO index_transactions (id, hash) values (5423218, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a02');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423217, 862606, 99570, 'ISSUE|0|CBTEST1|100||0|Callback Token|100');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423218, 862606, 99570, 'ISSUE|0|CBTEST2|100||0|Callback Reward Token|100');

-- Update callback token with reward info
INSERT INTO index_transactions (id, hash) values (5423219, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a03');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423219, 862607, 99570, 'ISSUE|4|CBTEST1|862610|CBTEST2|1');

-- Send callback token to a few users
INSERT INTO index_transactions (id, hash) values (5423220, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a04');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423220, 862608, 99570, 'SEND|1|CBTEST1|1|17YCEZgooP2jJ1gPM6ffKzBLkhxreuLJS8|2|12a9KsYiLg3nHNpKTbQ9oJ3dxHK3kL4tnS|3|bc1q0u35a3x3ee692myk7gjx3f57rxzthsxa72p28u|Sending callback token');

-- Callback Token and hand out reward token
INSERT INTO index_transactions (id, hash) values (5423221, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a05');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423221, 862611, 99570, 'CALLBACK|0|CBTEST1|Callback on CBTEST1');

-- Create callback and reward tokens (divisible)
INSERT INTO index_transactions (id, hash) values (5423222, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a06');
INSERT INTO index_transactions (id, hash) values (5423223, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a07');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423222, 862612, 99570, 'ISSUE|0|CBTEST3|100||8|Callback Token (divisible)|100');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423223, 862612, 99570, 'ISSUE|0|CBTEST4|100||8|Callback Reward Token(divisible)|100');

-- Update callback token with reward info
INSERT INTO index_transactions (id, hash) values (5423224, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a08');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423224, 862613, 99570, 'ISSUE|4|CBTEST3|862620|CBTEST4|0.5');

-- Send callback token to a few users
INSERT INTO index_transactions (id, hash) values (5423225, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a09');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423225, 862614, 99570, 'SEND|1|CBTEST3|1|17YCEZgooP2jJ1gPM6ffKzBLkhxreuLJS8|2|12a9KsYiLg3nHNpKTbQ9oJ3dxHK3kL4tnS|3|bc1q0u35a3x3ee692myk7gjx3f57rxzthsxa72p28u|Sending callback token');

-- Callback Token and hand out reward token
INSERT INTO index_transactions (id, hash) values (5423226, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a10');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423226, 862621, 99570, 'CALLBACK|0|CBTEST3|Callback on CBTEST3');

-- Update Address and include memo
INSERT INTO index_transactions (id, hash) values (5423227, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a11');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423227, 862622, 99570, 'ADDR|0|1|1|my address update');

-- Update Address and include invalid memo
INSERT INTO index_transactions (id, hash) values (5423228, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a12');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423228, 862623, 99570, 'ADDR|0|1|1|this is a really long memo which is way too long.this is a really long memo which is way too long.this is a really long memo which is way too long.this is a really long memo which is way too long.this is a really long memo which is way too long......');

-- Upload some files
INSERT INTO index_transactions (id, hash) values (5423229, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a13');
INSERT INTO index_transactions (id, hash) values (5423230, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a14');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423229, 862624, 99570, 'FILE|0|test.txt|text/plain|Test File|This is a test upload');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423230, 862624, 99570, 'FILE|0|xchain.jpg|image/jpeg|XChain Logo|This is the official XChain Logo');

-- Create some links
INSERT INTO index_transactions (id, hash) values (5423231, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a15');
INSERT INTO index_transactions (id, hash) values (5423232, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a16');
INSERT INTO index_transactions (id, hash) values (5423233, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a17');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423231, 862625, 99570, 'LINK|0|BTC|1234|BTC|4321|Linking FILE upload to TICK');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423232, 862625, 99570, 'LINK|0|BTC|1234|DOGE|6666|Linking TICK with FILE upload on DOGE');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423233, 862625, 99570, 'LINK|0|BTC|9999999999|DOGE|6666|linking to invalid transaction');

-- Create some broadcasts
INSERT INTO index_transactions (id, hash) values (5423234, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a18');
INSERT INTO index_transactions (id, hash) values (5423235, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a19');
INSERT INTO index_transactions (id, hash) values (5423236, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a20');
INSERT INTO index_transactions (id, hash) values (5423237, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a21');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423234, 862626, 99570, 'BROADCAST|0|This is a test');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423235, 862626, 99570, 'BROADCAST|1|BTC-USD|84860|0.01|BTC Price on Sat Apr 12 2025 14:35:36 UTC');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423236, 862626, 99570, 'BROADCAST|2|https://oracle-betting-site.com/superbowl-2025.json|1|Bet on the 2025 Superbowl!');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423237, 862626, 99570, 'BROADCAST|3|1234|2|Superbowl Results on Tue Aug 19 2025 01:55:00 UTC');


-- Create some broadcasts
INSERT INTO index_transactions (id, hash) values (5423238, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a22');
INSERT INTO index_transactions (id, hash) values (5423239, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a23');
INSERT INTO index_transactions (id, hash) values (5423240, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a24');
INSERT INTO index_transactions (id, hash) values (5423241, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a25');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423238, 862627, 99570, 'MESSAGE|0|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|PUBLIC_KEY_GOES_HERE');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423239, 862627, 99570, 'MESSAGE|1|1Donatet2LrNpuWByAnH8gc9Wh9zSzZuLC|1|PUBLIC_KEY_GOES_HERE');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423240, 862627, 99570, 'MESSAGE|2|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|ENCRYPTED_MESSAGE_GOES_HERE');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423241, 862627, 99570, 'MESSAGE|3|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|Hello');

-- Create some sleeps
INSERT INTO index_transactions (id, hash) values (5423242, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a26');
INSERT INTO index_transactions (id, hash) values (5423243, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a27');
INSERT INTO index_transactions (id, hash) values (5423244, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a28');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423242, 862628, 99570, 'SLEEP|1|862630|JDOG|Pausing actions on JDOG until block 791495');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423243, 862628, 99570, 'SLEEP|0|862630|Pausing address actions until block 791495');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423244, 862628, 99570, 'SLEEP|0|862630|Testing Sleep which should fail');

-- invalid ISSUE
INSERT INTO index_transactions (id, hash) values (5423245, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a29');
INSERT INTO index_transactions (id, hash) values (5423246, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a30');
INSERT INTO index_transactions (id, hash) values (5423247, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a31');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423245, 862631, 99570, 'ISSUE|0|^abc1234567');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423246, 862631, 99570, 'ISSUE|0|abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789~!@#$%^&*()_+-={}[]:<>?\/');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423247, 862631, 99570, 'ISSUE|0|Testing"stuff');

-- Token and sub-token issuances
INSERT INTO index_transactions (id, hash) values (5423248, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a32');
INSERT INTO index_transactions (id, hash) values (5423249, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a33');
INSERT INTO index_transactions (id, hash) values (5423250, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a34');
INSERT INTO index_transactions (id, hash) values (5423251, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a35');
INSERT INTO index_transactions (id, hash) values (5423252, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a36');
INSERT INTO index_transactions (id, hash) values (5423253, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a37');
INSERT INTO index_transactions (id, hash) values (5423254, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a38');
INSERT INTO index_transactions (id, hash) values (5423255, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a39');
INSERT INTO index_transactions (id, hash) values (5423256, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a40');
INSERT INTO index_transactions (id, hash) values (5423257, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a41');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423248, 862632, 99570, 'ISSUE|0|JDOG');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423249, 862632, 99570, 'ISSUE|0|JDOG.LOVES');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423250, 862632, 99570, 'ISSUE|0|JDOG.LOVES.BACON');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423251, 862632, 99570, 'ISSUE|0|JDOG.LOVES.BÅCON');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423252, 862632, 99570, 'ISSUE|0|JDOG.LOVES.');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423253, 862632, 99570, 'ISSUE|0|.LOVES.BACON');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423254, 862632, 99570, 'ISSUE|0|JDOG.LOVES.YUMMY.BACON');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423255, 862633, 99570, 'ISSUE|0|BDUSSY');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423256, 862633, 99570, 'ISSUE|0|BDUSSY.EAT');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423257, 862633, 99570, 'ISSUE|0|BDUSSY.EAT.IT');

-- create a swap
INSERT INTO index_transactions (id, hash) values (5423258, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a42');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423258, 862634, 99570, 'SWAP|0|BTC|GOD|1|BTC|GAS|20||1767254400|||swap expires Jan 1 2026');

-- Cancel a swap
INSERT INTO index_transactions (id, hash) values (5423259, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a43');
INSERT INTO index_transactions (id, hash) values (5423260, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a44');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423259, 862635, 99570, 'SWAP|1|74960|Cancelling swap');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423260, 862635, 99570, 'SWAP|1|74969|Cancelling swap');

-- Edit swap (invalid)
INSERT INTO index_transactions (id, hash) values (5423261, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a45');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423261, 862636, 99570, 'SWAP|2|74960|1769932800|||invalid swap edit');

-- create a swap
INSERT INTO index_transactions (id, hash) values (5423262, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a46');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423262, 862637, 99570, 'SWAP|0|BTC|GOD|1|BTC|GAS|20|||||swap with default expiration');

-- Edit swap (valid)
INSERT INTO index_transactions (id, hash) values (5423263, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a47');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423263, 862638, 99570, 'SWAP|2|74964|1769932800|||Extending EXPIRATION until Feb 1 2026');

-- create a matching swap
INSERT INTO index_transactions (id, hash) values (5423264, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a48');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423264, 862639, 382504, 'SWAP|0|BTC|GAS|20|BTC|GOD|1|||||matching swap test');

-- create a swap with bad allow/block lists
INSERT INTO index_transactions (id, hash) values (5423265, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a49');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423265, 862640, 382504, 'SWAP|0|BTC|GOD|1|BTC|GAS|20|||1234|1234|testing bad lists');

-- create a swap with good allow/block lists
INSERT INTO index_transactions (id, hash) values (5423266, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a50');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423266, 862640, 382504, 'SWAP|0|BTC|GOD|1|BTC|GAS|20|||74838|1152|testing good lists');

-- Edit swap with good allow/block lists
INSERT INTO index_transactions (id, hash) values (5423267, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a51');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423267, 862641, 382504, 'SWAP|2|74969||1152|74838|changing lists');

-- Edit swap with bad allow/block lists
INSERT INTO index_transactions (id, hash) values (5423268, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a52');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423268, 862642, 382504, 'SWAP|2|74969||1234|1234|bad list test');

-- Edit swap with bad allow/block lists
INSERT INTO index_transactions (id, hash) values (5423269, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a53');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423269, 862643, 382504, 'SWAP|2|74969|1234|||bad expiration test');

-- Cancel a swap
INSERT INTO index_transactions (id, hash) values (5423270, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a54');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423270, 862644, 382504, 'SWAP|1|74969|Cancelling swap');

-- Create a order
INSERT INTO index_transactions (id, hash) values (5423271, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a55');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423271, 862645, 382504, 'ORDER|0|BTC|GOD|1|BTC|GAS|20||1767254400|||order expires Jan 1 2026');

-- create a matching order (single)
INSERT INTO index_transactions (id, hash) values (5423272, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a56');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423272, 862645, 99570, 'ORDER|0|BTC|GAS|20|BTC|GOD|1||1767254400|||matching order expires Jan 1 2026');

-- Create a order
INSERT INTO index_transactions (id, hash) values (5423273, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a57');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423273, 862646, 99570, 'ORDER|0|BTC|GOD|1|BTC|GAS|20|||||default order');

-- Cancel an order
INSERT INTO index_transactions (id, hash) values (5423274, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a58');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423274, 862647, 99570, 'ORDER|1|74977|Cancelling order');

-- create a order
INSERT INTO index_transactions (id, hash) values (5423275, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a59');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423275, 862648, 382504, 'ORDER|0|BTC|GAS|5|BTC|GOD|1||1767254400|||order expires Jan 1 2026');

-- edit an order with bad expiration
INSERT INTO index_transactions (id, hash) values (5423276, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a60');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423276, 862649, 382504, 'ORDER|2|74979|1234|||bad expiration test');

-- edit an a order with good expire date
INSERT INTO index_transactions (id, hash) values (5423277, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a61');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423277, 862650, 382504, 'ORDER|2|74979|1769932800|||Extending EXPIRATION until Feb 1 2026');

-- edit an order with good allow/block lists
INSERT INTO index_transactions (id, hash) values (5423278, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a62');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423278, 862651, 382504, 'ORDER|2|74979||74838|1152|good lists');

-- Cancel an order
INSERT INTO index_transactions (id, hash) values (5423279, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a63');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423279, 862652, 382504, 'ORDER|1|74979|Cancelling order');

-- Create PEPECREATURE asset
INSERT INTO index_transactions (id, hash) values (5423280, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a64');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423280, 862653, 99570, 'ISSUE|0|PEPECREATURE|0|0|0|https://suu7st3k2g56jaz4kcwtca7zs4wlvqbspng2v4c33674sztjapkq.arweave.net/lSn5T2rRu-SDPFCtMQP5lyy6wDJ7TarwW9-_yWZpA9U/pepecreature7.json');

-- create a order
INSERT INTO index_transactions (id, hash) values (5423281, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a65');
INSERT INTO index_transactions (id, hash) values (5423282, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a66');
INSERT INTO index_transactions (id, hash) values (5423283, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a67');
INSERT INTO index_transactions (id, hash) values (5423284, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a68');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423281, 862654, 382504, 'ORDER|0|BTC|GAS|5|BTC|SAT|1|||||5 GAS = 1 SAT');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423282, 862654, 382504, 'ORDER|0|BTC|GAS|5|BTC|SAT|1|||||5 GAS = 1 SAT');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423283, 862654, 382504, 'ORDER|0|BTC|GAS|5|BTC|SAT|1|||||5 GAS = 1 SAT');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423284, 862654, 382504, 'ORDER|0|BTC|GAS|5|BTC|SAT|1|||||5 GAS = 1 SAT');

-- create a matching order (multiple)
INSERT INTO index_transactions (id, hash) values (5423285, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a69');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423285, 862655, 99570, 'ORDER|0|BTC|SAT|5|BTC|GAS|25|||||5 SAT = 25 GAS');

-- Create final matching order 
INSERT INTO index_transactions (id, hash) values (5423286, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a70');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423286, 862656, 382504, 'ORDER|0|BTC|GAS|5|BTC|SAT|1|||||5 GAS = 1 SAT');

DELETE FROM index_transactions where id>=5423287;
DELETE FROM transactions where tx_hash_id>=5423287;
DELETE FROM transactions where block_index>=862657;

-- create a swap which expires in the next block
INSERT INTO index_transactions (id, hash) values (5423287, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a71');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423287, 862657, 99570, 'SWAP|0|BTC|GOD|1|BTC|GAS|20||1727173395|||swap that expires next block');

-- Create a order which expires in the next block
INSERT INTO index_transactions (id, hash) values (5423288, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a72');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423288, 862658, 99570, 'ORDER|0|BTC|GAS|20|BTC|GOD|1||1727173895|||order that expires next block');

-- Create a dispenser dispense 1 GOD token for every 0.01 BTC
INSERT INTO index_transactions (id, hash) values (5423289, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a73');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423289, 862660, 99570, 'DISPENSER|0|BTC|GAS|1|10|BTC||0.001|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||||Creating GAS dispensers at 0.001 BTC each');

-- Edit dispenser (refill)
INSERT INTO index_transactions (id, hash) values (5423290, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a74');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423290, 862661, 99570, 'DISPENSER|2|75000|5||||Refilling dispenser with 5 more GAS');

-- Edit dispenser (change expiration)
INSERT INTO index_transactions (id, hash) values (5423291, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a75');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423291, 862661, 99570, 'DISPENSER|2|75000||1763440516|||changing dispenser expiration');

-- Edit dispenser (change allow/block lists)
INSERT INTO index_transactions (id, hash) values (5423292, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a76');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423292, 862661, 99570, 'DISPENSER|2|75000|||74838|1152|changing allow/block lists (valid)');

-- Cancel dispenser
-- INSERT INTO index_transactions (id, hash) values (5423293, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a77');
-- INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423293, 862662, 99570, 'DISPENSER|1|75000|closing dispenser');

-- Create ticker dispensers
INSERT INTO index_transactions (id, hash) values (5423294, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a78');
INSERT INTO index_transactions (id, hash) values (5423295, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a79');
INSERT INTO index_transactions (id, hash) values (5423296, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a80');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423294, 862662, 99570, 'DISPENSER|0|BTC|SAT|1.2345678|2|BTC|GAS|1.00000001|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||||Creating SAT dispensers for GAS');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423295, 862662, 99570, 'DISPENSER|0|BTC|USD|1.2345678|2|BTC|GAS|1.00000001|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||||Creating USD dispensers for GAS');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423296, 862662, 99570, 'DISPENSER|0|BTC|BRRR|2|2|BTC|GAS|1.00000001|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||||Creating BRRR dispensers for GAS');

-- Send payment to dispenser address that triggers multiple dispensers
INSERT INTO index_transactions (id, hash) values (5423297, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a81');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423297, 862662, 382504, 'SEND|0|GAS|1.00000001|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|triggering dispensers with tick payment');

-- Create a dispenser dispense 1 GAS token for every 0.0001 BTC
INSERT INTO index_transactions (id, hash) values (5423299, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a83');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423299, 862663, 99570, 'DISPENSER|0|BTC|GAS|1|200|BTC||0.0001|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||||Creating GAS dispensers at 0.0001 BTC each');
INSERT INTO index_transactions (id, hash) values (5423301, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a85');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423301, 862663, 99570, 'DISPENSER|0|BTC|GAS|1|200|BTC||0.001|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||||Creating GAS dispensers at 0.001 BTC each');

-- Create transaction with 3 outputs that trigger dispensers
INSERT INTO index_transactions (id, hash) values (5423300, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a84');
INSERT INTO transactions (tx_hash_id, block_index, source_id, has_dispenses, data) values(5423300, 862663, 382504, 1, 'DISPENSE');

SELECT * from transactions where data='DISPENSE';

INSERT INTO transaction_outputs (tx_index, vout, destination_id, amount) values (75808, 0, 99570, '0.0001');
INSERT INTO transaction_outputs (tx_index, vout, destination_id, amount) values (75808, 1, 99570, '0.001');
INSERT INTO transaction_outputs (tx_index, vout, destination_id, amount) values (75808, 2, 99570, '0.01');
INSERT INTO transaction_outputs (tx_index, vout, destination_id, amount) values (75808, 3, 99570, '0.1');
INSERT INTO transaction_outputs (tx_index, vout, destination_id, amount) values (75808, 4, 99570, '0.1');
INSERT INTO transaction_outputs (tx_index, vout, destination_id, amount) values (75808, 5, 99570, '0.1');


DELETE FROM index_transactions where id>=5423302;
DELETE FROM transactions where tx_hash_id>=5423302;
DELETE FROM transactions where block_index>=862663;

-- Create a order
INSERT INTO index_transactions (id, hash) values (5423302, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a85');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423302, 862663, 99570, 'ORDER|0|BTC|SAT|1|BTC|GAS|20|||||default order');

-- create a swap
INSERT INTO index_transactions (id, hash) values (5423303, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a86');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423303, 862663, 99570, 'SWAP|0|BTC|SAT|1|BTC|GAS|20|||||swap with default expiration');

-- create a dispenser
INSERT INTO index_transactions (id, hash) values (5423304, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a87');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423304, 862663, 99570, 'DISPENSER|0|BTC|GAS|1|200|BTC||0.001|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev||||||Creating GAS dispensers at 0.001 BTC each');

-- Create a sweep
INSERT INTO index_transactions (id, hash) values (5423305, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a88');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423305, 862664, 99570, 'SWEEP|0|bc1qgy3257sj405sw9y9l6sj0k2q3rlz9mx6m3svj4|1|1|1|Creating sweep of everything');

-- Create a sweep to sweep everything back (after escrowed tokens have been returned)
INSERT INTO index_transactions (id, hash) values (5423306, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a89');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423306, 862672, 382504, 'SWEEP|0|1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|1|1|1|Sweep to return to original address');

-- Create issue with a memo
INSERT INTO index_transactions (id, hash) values (5423307, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a90');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423307, 862672, 99570, 'ISSUE|0|JDOG.LOVES.MEMOS||||testing memos||||||||||||||||||||this is an issue memo');

INSERT INTO index_transactions (id, hash) values (5423308, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a91');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423308, 862672, 99570, 'ISSUE|0|DIVIDENDTEST|21000000|||testing dividends|21000000|||||||||||||||||||');

INSERT INTO index_transactions (id, hash) values (5423309, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a92');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423309, 862673, 99570, 'DIVIDEND|0|SAT|DIVIDENDTEST|1|Testing dividends');
INSERT INTO index_transactions (id, hash) values (5423310, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a93');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423310, 862673, 99570, 'DIVIDEND|0|SAT|GAS|0.00000001|Testing divisible dividends');

INSERT INTO events (time, code, data) values ('2025-11-03T20:10:03', 'REORG', '[862663]');

INSERT INTO index_transactions (id, hash) values (5423311, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a94');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423311, 862674, 382504, 'ADDR|0||1|require memo');

INSERT INTO index_transactions (id, hash) values (5423312, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a95');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423312, 862674, 99570, 'SEND|0|GAS|1.00000001|bc1qgy3257sj405sw9y9l6sj0k2q3rlz9mx6m3svj4');

INSERT INTO index_transactions (id, hash) values (5423313, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a96');
INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423313, 862674, 99570, 'SEND|0|GAS|1.00000001|bc1qgy3257sj405sw9y9l6sj0k2q3rlz9mx6m3svj4|testing memo requirement');


-- DELETE FROM index_transactions where id>=5423302;
-- DELETE FROM transactions where tx_hash_id>=5423302;
-- DELETE FROM transactions where block_index>=862673;

-- Send payment to dispenser address that triggers multiple dispensers
-- INSERT INTO index_transactions (id, hash) values (5423298, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a82');
-- INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423298, 862663, 99570, 'DISPENSER|0|BTC|SAT|1.2345678|2|BTC|||1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev|USD|FOO||||Creating SAT dispensers for 10.00 USD');




DELETE FROM index_transactions where id>=5423294;
DELETE FROM transactions where tx_hash_id>=5423294;
DELETE FROM transactions where block_index>=862666;

-- Create an airdrop
INSERT INTO index_transactions (id, hash) values (5423294, 'cd9f6b71c9d43ef66147cba878a015d0b042005fb3aedc05d7a3171bf9e92a78');
-- INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423294, 862666, 99570, 'AIRDROP|0|USD|1|1191|airdrop test format 0');
-- INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423294, 862666, 99570, 'AIRDROP|1|1191|USD|1|SAT|1|airdrop test format 1');
-- INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423294, 862666, 99570, 'AIRDROP|2|USD|1|1191|SAT|1|1191|airdrop test format 2');
-- INSERT INTO transactions (tx_hash_id, block_index, source_id, data) values(5423294, 862666, 99570, 'AIRDROP|3|USD|1|1191|memo1|SAT|1|1191|memo2');






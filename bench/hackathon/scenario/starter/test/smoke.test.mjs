import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../storage/db.mjs';
test('three starter slots exist',()=>{const db=openStore(':memory:');assert.equal(db.listSlots().length,3);db.close();});

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import {test} from 'node:test';
import './dictation-inline-controller.test.ts';
import {assertOwnPendingInputGuards} from './dictation-input-inline.test.ts';

test('AC-4: own pending input and foreign lease guards', () => {
  assertOwnPendingInputGuards();
});

const validator = require('@app-core/validator');
const PaymentMessages = require('@app/messages/payment');
const { appLogger } = require('@app-core/logger');

// CONSTANTS

const ALLOWED_CURRENCIES = new Set(['NGN', 'USD', 'GBP', 'GHS']);

const TRANSACTION_TYPES = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
};

const STATUS_CODES = {
  SUCCESS: 'AP00',
  PENDING: 'AP02',
  INSUFFICIENT_FUNDS: 'AC01',
  SAME_ACCOUNT: 'AC02',
  ACCOUNT_NOT_FOUND: 'AC03',
  INVALID_ACCOUNT_ID: 'AC04',
  CURRENCY_MISMATCH: 'CU01',
  UNSUPPORTED_CURRENCY: 'CU02',
  INVALID_DATE: 'DT01',
  INVALID_AMOUNT: 'AM01',
  MISSING_KEYWORD: 'SY01',
  INVALID_KEYWORD: 'SY02',
  MALFORMED: 'SY03',
};

const INSTRUCTION_PATTERNS = {
  DEBIT: [
    { idx: 3, keyword: 'FROM' },
    { idx: 4, keyword: 'ACCOUNT' },
    { idx: 6, keyword: 'FOR' },
    { idx: 7, keyword: 'CREDIT' },
    { idx: 8, keyword: 'TO' },
    { idx: 9, keyword: 'ACCOUNT' },
  ],
  CREDIT: [
    { idx: 3, keyword: 'TO' },
    { idx: 4, keyword: 'ACCOUNT' },
    { idx: 6, keyword: 'FOR' },
    { idx: 7, keyword: 'DEBIT' },
    { idx: 8, keyword: 'FROM' },
    { idx: 9, keyword: 'ACCOUNT' },
  ],
};

const VALIDATION_SPEC = `root {
  accounts[] {
    id string
    balance number
    currency string
  }
  instruction string
}`;

const parsedSpec = validator.parse(VALIDATION_SPEC);

// STRING UTILITIES

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function isNearMatch(a, b) {
  try {
    return levenshteinDistance(a, b) <= 1;
  } catch {
    return false;
  }
}

function tokenize(instruction) {
  return instruction
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function uppercaseTokens(tokens) {
  return tokens.map((token) => token.toUpperCase());
}

// VALIDATION UTILITIES

function validateDigits(value) {
  if (typeof value !== 'string') {
    return { valid: false, error: 'Amount must be a string' };
  }
  if (value.length === 0) {
    return { valid: false, error: 'Amount must not be empty' };
  }

  let invalidError = null;
  value.split('').some((char) => {
    if (char === '-') {
      invalidError = 'Amount cannot contain negative sign';
      return true;
    }
    if (char === '.') {
      invalidError = 'Amount cannot contain decimal point';
      return true;
    }
    if (char < '0' || char > '9') {
      invalidError = `Invalid character '${char}' in amount`;
      return true;
    }
    return false;
  });

  if (invalidError) {
    return { valid: false, error: invalidError };
  }

  return { valid: true };
}

function validateAccountId(id) {
  if (typeof id !== 'string') {
    return { valid: false, error: 'Account id must be a string' };
  }
  if (id.length === 0) {
    return { valid: false, error: 'Account id must not be empty' };
  }

  function isAllowedChar(char) {
    return (
      (char >= '0' && char <= '9') ||
      (char >= 'A' && char <= 'Z') ||
      (char >= 'a' && char <= 'z') ||
      char === '-' ||
      char === '.' ||
      char === '@'
    );
  }

  const invalidChar = id.split('').find((char) => !isAllowedChar(char));
  if (invalidChar) {
    return { valid: false, error: `Invalid character '${invalidChar}' in account id` };
  }

  return { valid: true };
}

function validateDateFormat(dateString) {
  if (typeof dateString !== 'string' || dateString.length !== 10) {
    return { valid: false, error: PaymentMessages.INVALID_DATE_FORMAT };
  }
  if (dateString[4] !== '-' || dateString[7] !== '-') {
    return { valid: false, error: PaymentMessages.INVALID_DATE_FORMAT };
  }

  const year = dateString.substring(0, 4);
  const month = dateString.substring(5, 7);
  const day = dateString.substring(8, 10);

  const yearCheck = validateDigits(year);
  const monthCheck = validateDigits(month);
  const dayCheck = validateDigits(day);

  if (!yearCheck.valid || !monthCheck.valid || !dayCheck.valid) {
    return { valid: false, error: PaymentMessages.INVALID_DATE_FORMAT };
  }

  const yearInt = parseInt(year, 10);
  const monthInt = parseInt(month, 10);
  const dayInt = parseInt(day, 10);

  if (monthInt < 1 || monthInt > 12) {
    return {
      valid: false,
      error: 'Invalid month, month must be between 1 and 12 in YYYY-MM-DD',
    };
  }
  if (dayInt < 1 || dayInt > 31) {
    return {
      valid: false,
      error: 'Invalid day, day cannot be greater than 31 in YYYY-MM-DD',
    };
  }

  const dateUTC = new Date(Date.UTC(yearInt, monthInt - 1, dayInt));
  const isValidDate =
    dateUTC.getUTCFullYear() === yearInt &&
    dateUTC.getUTCMonth() + 1 === monthInt &&
    dateUTC.getUTCDate() === dayInt;

  if (!isValidDate) {
    return { valid: false, error: PaymentMessages.INVALID_DATE_FORMAT };
  }

  return { valid: true, value: dateString };
}

function getTodayUTC() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// KEYWORD VALIDATION

function validateKeywords(tokens, pattern) {
  const missing = [];
  const mismatched = [];

  pattern.forEach(({ idx, keyword }) => {
    if (tokens.length <= idx) {
      missing.push(keyword);
    } else if (tokens[idx] !== keyword) {
      mismatched.push({ expected: keyword, found: tokens[idx] });
    }
  });

  if (missing.length > 0) {
    return {
      valid: false,
      code: STATUS_CODES.MISSING_KEYWORD,
      message: `Missing keyword(s): ${missing.join(', ')}`,
    };
  }

  if (mismatched.length > 0) {
    const details = mismatched.map(({ expected, found }) => {
      let note = `expected '${expected}' but found '${found}'`;
      if (found && isNearMatch(expected, found)) {
        note += ` (did you mean '${expected}'?)`;
      }
      return note;
    });
    return {
      valid: false,
      code: STATUS_CODES.INVALID_KEYWORD,
      message: `Invalid keyword(s): ${details.join('; ')}`,
    };
  }

  return { valid: true };
}

// INSTRUCTION PARSING

function extractTokenPositions(type, tokens) {
  const isDebit = type === TRANSACTION_TYPES.DEBIT;
  const fromIdx = isDebit ? 5 : 10;
  const toIdx = isDebit ? 10 : 5;
  const onIdx = 11;
  const dateIdx = onIdx + 1;

  const sawON = typeof tokens[onIdx] === 'string' && tokens[onIdx].toUpperCase() === 'ON';

  const dateToken = sawON && tokens.length > dateIdx ? tokens[dateIdx] : null;
  const hasIncompleteDate = tokens.length === dateIdx && sawON;

  return {
    amount: tokens[1],
    currency: tokens[2],
    fromAccount: tokens[fromIdx],
    toAccount: tokens[toIdx],
    dateToken,
    hasIncompleteDate,
    sawONKeyword: tokens.length < 12 ? true : sawON,
  };
}

function parseAmount(amountToken) {
  const validation = validateDigits(amountToken);
  if (!validation.valid) {
    return {
      valid: false,
      code: STATUS_CODES.INVALID_AMOUNT,
      message: `${PaymentMessages.INVALID_AMOUNT}: ${validation.error}`,
    };
  }

  const amount = parseInt(amountToken, 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      valid: false,
      code: STATUS_CODES.INVALID_AMOUNT,
      message: PaymentMessages.INVALID_AMOUNT,
    };
  }

  return { valid: true, value: amount };
}

function parseCurrency(currencyToken) {
  if (!currencyToken) {
    return {
      valid: false,
      code: STATUS_CODES.UNSUPPORTED_CURRENCY,
      message: `${PaymentMessages.UNSUPPORTED_CURRENCY}, but found '${currencyToken}'`,
    };
  }

  const currency = currencyToken.toUpperCase();
  if (!ALLOWED_CURRENCIES.has(currency)) {
    return {
      valid: false,
      code: STATUS_CODES.UNSUPPORTED_CURRENCY,
      message: `${PaymentMessages.UNSUPPORTED_CURRENCY}, but found '${currency}'`,
    };
  }

  return { valid: true, value: currency };
}

function parseAccounts(fromId, toId, type) {
  const fromValidation = validateAccountId(fromId);
  const toValidation = validateAccountId(toId);

  if (!fromValidation.valid) {
    return {
      valid: false,
      code: STATUS_CODES.INVALID_ACCOUNT_ID,
      message: `${PaymentMessages.INVALID_ACCOUNT_ID} (from: ${fromValidation.error})`,
    };
  }

  if (!toValidation.valid) {
    return {
      valid: false,
      code: STATUS_CODES.INVALID_ACCOUNT_ID,
      message: `${PaymentMessages.INVALID_ACCOUNT_ID} (to: ${toValidation.error})`,
    };
  }

  return {
    valid: true,
    debitAccount: type === TRANSACTION_TYPES.DEBIT ? fromId : toId,
    creditAccount: type === TRANSACTION_TYPES.DEBIT ? toId : fromId,
  };
}

function parseExecutionDate(positions) {
  if (positions.hasIncompleteDate && positions.dateToken === null) {
    return {
      valid: false,
      code: STATUS_CODES.INVALID_DATE,
      message: "No date provided after 'ON' keyword: date format is YYYY-MM-DD",
    };
  }
  if (!positions.sawONKeyword) {
    if (positions.dateToken !== null) {
      return {
        valid: false,
        code: STATUS_CODES.INVALID_DATE,
        message: "Date provided without 'ON' keyword: date format is YYYY-MM-DD",
      };
    }
    return {
      valid: false,
      code: STATUS_CODES.MISSING_KEYWORD,
      message: `${PaymentMessages.MISSING_KEYWORD}: 'ON'`,
    };
  }

  if (!positions.dateToken) {
    return { valid: true, value: null };
  }

  const dateValidation = validateDateFormat(positions.dateToken);
  if (!dateValidation.valid) {
    return {
      valid: false,
      code: STATUS_CODES.INVALID_DATE,
      message: dateValidation.error,
    };
  }

  return { valid: true, value: dateValidation.value };
}

function parseInstructionTokens(tokens, uppercaseTransactionTokens) {
  const type = uppercaseTransactionTokens[0];

  if (!TRANSACTION_TYPES[type]) {
    return { valid: false };
  }

  const keywordValidation = validateKeywords(
    uppercaseTransactionTokens,
    INSTRUCTION_PATTERNS[type]
  );

  if (!keywordValidation.valid) {
    return {
      valid: false,
      type,
      error: {
        code: keywordValidation.code,
        message: keywordValidation.message,
      },
    };
  }

  const positions = extractTokenPositions(type, tokens);
  const dateResult = parseExecutionDate(positions);

  if (!dateResult.valid) {
    return {
      valid: false,
      type,
      error: {
        code: dateResult.code,
        message: dateResult.message,
      },
    };
  }

  const amountResult = parseAmount(positions.amount);
  if (!amountResult.valid) {
    return {
      valid: false,
      type,
      error: {
        code: amountResult.code,
        message: amountResult.message,
      },
    };
  }

  const currencyResult = parseCurrency(positions.currency);
  if (!currencyResult.valid) {
    return {
      valid: false,
      type,
      error: {
        code: currencyResult.code,
        message: currencyResult.message,
      },
    };
  }

  const accountsResult = parseAccounts(positions.fromAccount, positions.toAccount, type);
  if (!accountsResult.valid) {
    return {
      valid: false,
      type,
      error: {
        code: accountsResult.code,
        message: accountsResult.message,
      },
    };
  }

  return {
    valid: true,
    type,
    amount: amountResult.value,
    currency: currencyResult.value,
    debitAccount: accountsResult.debitAccount,
    creditAccount: accountsResult.creditAccount,
    executeBy: dateResult.value,
  };
}

// ACCOUNT OPERATIONS

function findAccountById(accounts, accountId) {
  return accounts.find((account) => account && account.id === accountId) || null;
}

function createAccountSnapshot(account) {
  return {
    id: account.id,
    balance: account.balance,
    balance_before: account.balance,
    currency: (account.currency || '').toUpperCase(),
  };
}

function getRelevantAccounts(accounts, debitAccountId, creditAccountId) {
  const results = [];
  const debitAccount = findAccountById(accounts, debitAccountId);
  const creditAccount = findAccountById(accounts, creditAccountId);

  if (debitAccount) {
    results.push(createAccountSnapshot(debitAccount));
  }

  if (creditAccount && creditAccount.id !== debitAccountId) {
    results.push(createAccountSnapshot(creditAccount));
  }

  return { accounts: results, debitAccount, creditAccount };
}

function updateAccountBalances(accountSnapshots, debitAccountId, creditAccountId, amount) {
  return accountSnapshots.map((account) => {
    if (account.id === debitAccountId) {
      return {
        ...account,
        balance: account.balance_before - amount,
      };
    }
    if (account.id === creditAccountId) {
      return {
        ...account,
        balance: account.balance_before + amount,
      };
    }
    return account;
  });
}

// BUSINESS RULE VALIDATION

function validateAccountsExist(debitAccount, creditAccount, parsedData) {
  if (!debitAccount && !creditAccount) {
    return {
      valid: false,
      status: 'failed',
      status_code: STATUS_CODES.ACCOUNT_NOT_FOUND,
      status_reason: PaymentMessages.ACCOUNT_NOT_FOUND,
      accounts: [],
    };
  }

  if (!debitAccount) {
    const creditSnapshot = createAccountSnapshot(creditAccount);
    return {
      valid: false,
      status: 'failed',
      status_code: STATUS_CODES.ACCOUNT_NOT_FOUND,
      status_reason: `${PaymentMessages.ACCOUNT_NOT_FOUND}: debit account ${parsedData.debitAccount} not found`,
      accounts: [creditSnapshot],
    };
  }

  if (!creditAccount) {
    const debitSnapshot = createAccountSnapshot(debitAccount);
    return {
      valid: false,
      status: 'failed',
      status_code: STATUS_CODES.ACCOUNT_NOT_FOUND,
      status_reason: `${PaymentMessages.ACCOUNT_NOT_FOUND}: credit account ${parsedData.creditAccount} not found`,
      accounts: [debitSnapshot],
    };
  }

  return { valid: true };
}

function validateCurrencyMatch(debitAccount, creditAccount, currency) {
  const debitCurrency = (debitAccount.currency || '').toUpperCase();
  const creditCurrency = (creditAccount.currency || '').toUpperCase();

  if (debitCurrency !== creditCurrency) {
    return {
      valid: false,
      code: STATUS_CODES.CURRENCY_MISMATCH,
      message: `${PaymentMessages.CURRENCY_MISMATCH}: debit account is ${debitCurrency}, credit account is ${creditCurrency}`,
    };
  }

  if (!ALLOWED_CURRENCIES.has(currency)) {
    return {
      valid: false,
      code: STATUS_CODES.UNSUPPORTED_CURRENCY,
      message: PaymentMessages.UNSUPPORTED_CURRENCY,
    };
  }

  if (currency !== debitCurrency) {
    return {
      valid: false,
      code: STATUS_CODES.CURRENCY_MISMATCH,
      message: `${PaymentMessages.CURRENCY_MISMATCH}: Instruction currency ${currency} does not match debit account currency ${debitCurrency}`,
    };
  }

  return { valid: true };
}

function validateDifferentAccounts(debitAccountId, creditAccountId) {
  if (debitAccountId === creditAccountId) {
    return {
      valid: false,
      code: STATUS_CODES.SAME_ACCOUNT,
      message: `${PaymentMessages.SAME_ACCOUNT_ERROR}: both accounts are ${debitAccountId}`,
    };
  }
  return { valid: true };
}

function validateSufficientFunds(debitAccount, amount) {
  if (typeof debitAccount.balance !== 'number' || debitAccount.balance < amount) {
    return {
      valid: false,
      code: STATUS_CODES.INSUFFICIENT_FUNDS,
      message: `${PaymentMessages.INSUFFICIENT_FUNDS}: available balance is ${debitAccount.balance} and required is ${amount}`,
    };
  }
  return { valid: true };
}

function determineTransactionStatus(executeBy) {
  if (!executeBy) {
    return {
      status: 'successful',
      status_code: STATUS_CODES.SUCCESS,
      status_reason: PaymentMessages.TRANSACTION_SUCCESSFUL,
    };
  }

  const today = getTodayUTC();
  if (executeBy > today) {
    return {
      status: 'pending',
      status_code: STATUS_CODES.PENDING,
      status_reason: PaymentMessages.TRANSACTION_PENDING,
    };
  }

  return {
    status: 'successful',
    status_code: STATUS_CODES.SUCCESS,
    status_reason: PaymentMessages.TRANSACTION_SUCCESSFUL,
  };
}

// RESPONSE BUILDERS

function buildUnparseableResponse() {
  return {
    type: null,
    amount: null,
    currency: null,
    debit_account: null,
    credit_account: null,
    execute_by: null,
    status: 'failed',
    status_reason: PaymentMessages.MALFORMED_INSTRUCTION,
    status_code: STATUS_CODES.MALFORMED,
    accounts: [],
  };
}

function buildErrorResponse(parsedData, error, accounts = []) {
  return {
    type: parsedData.type || null,
    amount: parsedData.amount || null,
    currency: parsedData.currency || null,
    debit_account: parsedData.debitAccount || null,
    credit_account: parsedData.creditAccount || null,
    execute_by: parsedData.executeBy || null,
    status: 'failed',
    status_reason: error.message,
    status_code: error.code,
    accounts,
  };
}

function buildSuccessResponse(parsedData, statusInfo, accountSnapshots) {
  const finalAccounts =
    statusInfo.status === 'successful'
      ? updateAccountBalances(
          accountSnapshots,
          parsedData.debitAccount,
          parsedData.creditAccount,
          parsedData.amount
        )
      : accountSnapshots;

  return {
    type: parsedData.type,
    amount: parsedData.amount,
    currency: parsedData.currency,
    debit_account: parsedData.debitAccount,
    credit_account: parsedData.creditAccount,
    execute_by: parsedData.executeBy,
    status: statusInfo.status,
    status_reason: statusInfo.status_reason,
    status_code: statusInfo.status_code,
    accounts: finalAccounts,
  };
}

// MAIN PROCESSING

function processBusinessRules(parsedData, allAccounts) {
  const { accounts, debitAccount, creditAccount } = getRelevantAccounts(
    allAccounts,
    parsedData.debitAccount,
    parsedData.creditAccount
  );

  const accountsValidation = validateAccountsExist(debitAccount, creditAccount, parsedData);
  if (!accountsValidation.valid) {
    return {
      ...parsedData,
      ...accountsValidation,
    };
  }

  const currencyValidation = validateCurrencyMatch(
    debitAccount,
    creditAccount,
    parsedData.currency
  );
  if (!currencyValidation.valid) {
    return buildErrorResponse(
      parsedData,
      { code: currencyValidation.code, message: currencyValidation.message },
      accounts
    );
  }

  const sameAccountValidation = validateDifferentAccounts(
    parsedData.debitAccount,
    parsedData.creditAccount
  );
  if (!sameAccountValidation.valid) {
    return buildErrorResponse(
      parsedData,
      { code: sameAccountValidation.code, message: sameAccountValidation.message },
      accounts
    );
  }

  const fundsValidation = validateSufficientFunds(debitAccount, parsedData.amount);
  if (!fundsValidation.valid) {
    return buildErrorResponse(
      parsedData,
      { code: fundsValidation.code, message: fundsValidation.message },
      accounts
    );
  }

  const statusInfo = determineTransactionStatus(parsedData.executeBy);
  return buildSuccessResponse(parsedData, statusInfo, accounts);
}

async function parseInstruction(serviceData) {
  let response;
  try {
    const data = validator.validate(serviceData, parsedSpec);
    const instruction = (data.instruction || '').trim();
    const { accounts } = data;

    const tokens = tokenize(instruction);
    const uppercase = uppercaseTokens(tokens);
    const parseResult = parseInstructionTokens(tokens, uppercase);

    if (!instruction) {
      response = buildUnparseableResponse();
    } else if (tokens.length === 0) {
      response = buildUnparseableResponse();
    } else if (!parseResult.valid) {
      // For parse errors, include relevant accounts if we can identify them
      const positions = extractTokenPositions(parseResult.type, tokens);
      const candidateAccounts = [];
      if (!parseResult.type) {
        console.log('No type');
        response = buildUnparseableResponse();
      } else {
        if (positions) {
          const debitId =
            parseResult.type === TRANSACTION_TYPES.DEBIT
              ? positions.fromAccount
              : positions.toAccount;
          const creditId =
            parseResult.type === TRANSACTION_TYPES.DEBIT
              ? positions.toAccount
              : positions.fromAccount;

          accounts.forEach((account) => {
            if (account && (account.id === debitId || account.id === creditId)) {
              candidateAccounts.push(createAccountSnapshot(account));
            }
          });
        }

        response = buildErrorResponse(parseResult, parseResult.error, candidateAccounts);
      }
    } else {
      response = processBusinessRules(parseResult, accounts);
    }

    return response;
  } catch (error) {
    appLogger.errorX(error, 'parse-instruction-error');
    throw error;
  }
}

module.exports = parseInstruction;

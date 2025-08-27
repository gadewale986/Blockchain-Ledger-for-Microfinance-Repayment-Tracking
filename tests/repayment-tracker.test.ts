// tests/RepaymentTracker.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface LoanDetails {
  borrower: string;
  lender: string;
  principalAmount: number;
  interestRate: number;
  duration: number;
  startBlock: number;
  status: number;
  totalRepaid: number;
  lastPaymentBlock: number;
  metadata: string;
}

interface RepaymentSchedule {
  dueBlock: number;
  dueAmount: number;
  paidAmount: number;
  paidBlock: number | null;
  isPaid: boolean;
  penaltyApplied: boolean;
}

interface PaymentHistory {
  loanId: number;
  installmentId: number;
  payer: string;
  amount: number;
  blockHeight: number;
  isLate: boolean;
  penaltyAmount: number;
  notes: string;
}

interface ContractState {
  loans: Map<number, LoanDetails>;
  repaymentSchedules: Map<string, RepaymentSchedule>; // Key: `${loanId}-${installmentId}`
  paymentHistory: Map<number, PaymentHistory>;
  contractPaused: boolean;
  admin: string;
  totalLoans: number;
  totalRepayments: number;
  currentBlock: number; // Mocked block height
}

// Mock contract implementation
class RepaymentTrackerMock {
  private state: ContractState = {
    loans: new Map(),
    repaymentSchedules: new Map(),
    paymentHistory: new Map(),
    contractPaused: false,
    admin: "deployer",
    totalLoans: 0,
    totalRepayments: 0,
    currentBlock: 1000, // Starting block
  };

  private ERR_LOAN_NOT_FOUND = 100;
  private ERR_UNAUTHORIZED = 101;
  private ERR_INVALID_AMOUNT = 102;
  private ERR_PAUSED = 106;
  private ERR_INVALID_LOAN_STATUS = 107;
  private ERR_METADATA_TOO_LONG = 108;
  private ERR_INVALID_INSTALLMENT = 105;
  private ERR_LOAN_ALREADY_CLOSED = 104;
  private ERR_INVALID_TIMESTAMP = 110;

  private STATUS_ACTIVE = 1;
  private STATUS_OVERDUE = 2;
  private STATUS_CLOSED = 3;
  private STATUS_DEFAULTED = 4;

  private advanceBlock(blocks: number = 1): void {
    this.state.currentBlock += blocks;
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.contractPaused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    this.state.contractPaused = false;
    return { ok: true, value: true };
  }

  registerLoan(
    loanId: number,
    borrower: string,
    lender: string,
    principalAmount: number,
    interestRate: number,
    duration: number,
    metadata: string
  ): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (principalAmount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (metadata.length > 500) {
      return { ok: false, value: this.ERR_METADATA_TOO_LONG };
    }
    if (this.state.loans.has(loanId)) {
      return { ok: false, value: this.ERR_LOAN_NOT_FOUND }; // Simulate existing
    }
    this.state.loans.set(loanId, {
      borrower,
      lender,
      principalAmount,
      interestRate,
      duration,
      startBlock: this.state.currentBlock,
      status: this.STATUS_ACTIVE,
      totalRepaid: 0,
      lastPaymentBlock: 0,
      metadata,
    });
    this.state.totalLoans += 1;
    return { ok: true, value: true };
  }

  addRepaymentInstallment(
    loanId: number,
    installmentId: number,
    dueBlock: number,
    dueAmount: number
  ): ClarityResponse<boolean> {
    const loan = this.state.loans.get(loanId);
    if (!loan) {
      return { ok: false, value: this.ERR_LOAN_NOT_FOUND };
    }
    if (dueAmount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (dueBlock <= loan.startBlock) {
      return { ok: false, value: this.ERR_INVALID_TIMESTAMP };
    }
    const key = `${loanId}-${installmentId}`;
    this.state.repaymentSchedules.set(key, {
      dueBlock,
      dueAmount,
      paidAmount: 0,
      paidBlock: null,
      isPaid: false,
      penaltyApplied: false,
    });
    return { ok: true, value: true };
  }

  submitRepayment(
    loanId: number,
    installmentId: number,
    amount: number,
    notes: string
  ): ClarityResponse<boolean> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const loan = this.state.loans.get(loanId);
    if (!loan) {
      return { ok: false, value: this.ERR_LOAN_NOT_FOUND };
    }
    const key = `${loanId}-${installmentId}`;
    const schedule = this.state.repaymentSchedules.get(key);
    if (!schedule) {
      return { ok: false, value: this.ERR_INVALID_INSTALLMENT };
    }
    if (loan.status !== this.STATUS_ACTIVE) {
      return { ok: false, value: this.ERR_INVALID_LOAN_STATUS };
    }
    if (schedule.isPaid) {
      return { ok: false, value: this.ERR_LOAN_ALREADY_CLOSED };
    }
    if (notes.length > 200) {
      return { ok: false, value: this.ERR_METADATA_TOO_LONG };
    }
    const overdueBlocks = Math.max(0, this.state.currentBlock - schedule.dueBlock);
    const penalty = overdueBlocks > 0 ? Math.min(schedule.dueAmount * overdueBlocks / 100, schedule.dueAmount * 10) : 0;
    const totalDue = schedule.dueAmount + penalty;
    if (amount < totalDue) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    const isLate = overdueBlocks > 0;

    // Update schedule
    this.state.repaymentSchedules.set(key, {
      ...schedule,
      paidAmount: amount,
      paidBlock: this.state.currentBlock,
      isPaid: true,
      penaltyApplied: isLate,
    });

    // Update loan
    this.state.loans.set(loanId, {
      ...loan,
      totalRepaid: loan.totalRepaid + amount,
      lastPaymentBlock: this.state.currentBlock,
    });

    // Log history
    const historyId = this.state.totalRepayments + 1;
    this.state.paymentHistory.set(historyId, {
      loanId,
      installmentId,
      payer: loan.borrower, // Assume caller is borrower
      amount,
      blockHeight: this.state.currentBlock,
      isLate,
      penaltyAmount: penalty,
      notes,
    });
    this.state.totalRepayments = historyId;

    // Simulate update status (simple: if all paid, close)
    // For test, assume single installment for simplicity
    this.state.loans.set(loanId, {
      ...loan,
      status: this.STATUS_CLOSED,
    });

    return { ok: true, value: true };
  }

  getLoanDetails(loanId: number): ClarityResponse<LoanDetails | null> {
    return { ok: true, value: this.state.loans.get(loanId) ?? null };
  }

  getRepaymentSchedule(loanId: number, installmentId: number): ClarityResponse<RepaymentSchedule | null> {
    const key = `${loanId}-${installmentId}`;
    return { ok: true, value: this.state.repaymentSchedules.get(key) ?? null };
  }

  getPaymentHistory(historyId: number): ClarityResponse<PaymentHistory | null> {
    return { ok: true, value: this.state.paymentHistory.get(historyId) ?? null };
  }

  markAsDefaulted(loanId: number, caller: string): ClarityResponse<boolean> {
    const loan = this.state.loans.get(loanId);
    if (!loan) {
      return { ok: false, value: this.ERR_LOAN_NOT_FOUND };
    }
    if (caller !== loan.lender) {
      return { ok: false, value: this.ERR_UNAUTHORIZED };
    }
    if (![this.STATUS_ACTIVE, this.STATUS_OVERDUE].includes(loan.status)) {
      return { ok: false, value: this.ERR_INVALID_LOAN_STATUS };
    }
    this.state.loans.set(loanId, { ...loan, status: this.STATUS_DEFAULTED });
    return { ok: true, value: true };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  borrower: "farmer_1",
  lender: "lender_1",
};

describe("RepaymentTracker Contract", () => {
  let contract: RepaymentTrackerMock;

  beforeEach(() => {
    contract = new RepaymentTrackerMock();
    vi.resetAllMocks();
  });

  it("should register a new loan successfully", () => {
    const result = contract.registerLoan(
      1,
      accounts.borrower,
      accounts.lender,
      10000,
      500,
      100,
      "Loan for farming equipment"
    );
    expect(result).toEqual({ ok: true, value: true });

    const details = contract.getLoanDetails(1);
    expect(details).toEqual({
      ok: true,
      value: expect.objectContaining({
        borrower: accounts.borrower,
        lender: accounts.lender,
        principalAmount: 10000,
        metadata: "Loan for farming equipment",
      }),
    });
  });

  it("should prevent registering loan with invalid amount", () => {
    const result = contract.registerLoan(
      1,
      accounts.borrower,
      accounts.lender,
      0,
      500,
      100,
      "Invalid loan"
    );
    expect(result).toEqual({ ok: false, value: 102 });
  });

  it("should add repayment installment", () => {
    contract.registerLoan(1, accounts.borrower, accounts.lender, 10000, 500, 100, "Test loan");

    const addResult = contract.addRepaymentInstallment(1, 1, 1100, 5000);
    expect(addResult).toEqual({ ok: true, value: true });

    const schedule = contract.getRepaymentSchedule(1, 1);
    expect(schedule).toEqual({
      ok: true,
      value: expect.objectContaining({ dueBlock: 1100, dueAmount: 5000, isPaid: false }),
    });
  });

  it("should submit repayment successfully", () => {
    contract.registerLoan(1, accounts.borrower, accounts.lender, 10000, 500, 100, "Test loan");
    contract.addRepaymentInstallment(1, 1, 1100, 5000);

    const repayResult = contract.submitRepayment(1, 1, 5000, "On-time payment");
    expect(repayResult).toEqual({ ok: true, value: true });

    const schedule = contract.getRepaymentSchedule(1, 1);
    expect(schedule.value?.isPaid).toBe(true);

    const history = contract.getPaymentHistory(1);
    expect(history).toEqual({
      ok: true,
      value: expect.objectContaining({ amount: 5000, isLate: false }),
    });
  });

  it("should prevent actions when paused", () => {
    contract.pauseContract(accounts.deployer);

    const registerResult = contract.registerLoan(1, accounts.borrower, accounts.lender, 10000, 500, 100, "Paused");
    expect(registerResult).toEqual({ ok: false, value: 106 });
  });

  it("should mark loan as defaulted by lender", () => {
    contract.registerLoan(1, accounts.borrower, accounts.lender, 10000, 500, 100, "Test loan");

    const defaultResult = contract.markAsDefaulted(1, accounts.lender);
    expect(defaultResult).toEqual({ ok: true, value: true });

    const details = contract.getLoanDetails(1);
    expect(details.value?.status).toBe(4); // DEFAULTED
  });

  it("should prevent non-lender from marking default", () => {
    contract.registerLoan(1, accounts.borrower, accounts.lender, 10000, 500, 100, "Test loan");

    const defaultResult = contract.markAsDefaulted(1, accounts.borrower);
    expect(defaultResult).toEqual({ ok: false, value: 101 });
  });
});
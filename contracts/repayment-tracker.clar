;; contracts/RepaymentTracker.clar
;; Core contract for tracking microfinance loan repayments.
;; This contract manages repayment schedules, records actual payments,
;; updates loan statuses, and provides immutable logs for credit building.
;; It assumes integration with LoanOrigination.clar for loan creation,
;; and CreditHistory.clar for updating credit profiles.
;; Designed for unbanked farmers: transparent, tamper-proof repayment tracking.

;; Constants for error codes
(define-constant ERR-LOAN-NOT-FOUND u100)
(define-constant ERR-UNAUTHORIZED u101)
(define-constant ERR-INVALID-AMOUNT u102)
(define-constant ERR-PAYMENT-OVERDUE u103)
(define-constant ERR-LOAN-ALREADY-CLOSED u104)
(define-constant ERR-INVALID-INSTALLMENT u105)
(define-constant ERR-PAUSED u106)
(define-constant ERR-INVALID-LOAN-STATUS u107)
(define-constant ERR-METADATA-TOO-LONG u108)
(define-constant ERR-NO-PENDING-PAYMENTS u109)
(define-constant ERR-INVALID-TIMESTAMP u110)

;; Constants for loan statuses
(define-constant STATUS-ACTIVE u1)
(define-constant STATUS-OVERDUE u2)
(define-constant STATUS-CLOSED u3)
(define-constant STATUS-DEFAULTED u4)

;; Data variables
(define-data-var contract-paused bool false)
(define-data-var admin principal tx-sender)
(define-data-var total-loans uint u0)
(define-data-var total-repayments uint u0)

;; Maps
;; Loan details map: basic info replicated here for efficiency (synced from LoanOrigination)
(define-map loans
  { loan-id: uint }
  {
    borrower: principal,
    lender: principal,
    principal-amount: uint,   ;; Initial loan amount in micro-STX or token units
    interest-rate: uint,      ;; Annual interest rate in basis points (e.g., 500 = 5%)
    duration: uint,           ;; Loan duration in blocks
    start-block: uint,
    status: uint,
    total-repaid: uint,
    last-payment-block: uint,
    metadata: (string-utf8 500)  ;; Additional loan notes, e.g., purpose for farming equipment
  }
)

;; Repayment schedule map: per loan, list of installments
(define-map repayment-schedules
  { loan-id: uint, installment-id: uint }
  {
    due-block: uint,
    due-amount: uint,         ;; Amount due for this installment (principal + interest)
    paid-amount: uint,
    paid-block: (optional uint),
    is-paid: bool,
    penalty-applied: bool
  }
)

;; Payment history log: immutable append-only log for each payment event
(define-map payment-history
  { history-id: uint }
  {
    loan-id: uint,
    installment-id: uint,
    payer: principal,
    amount: uint,
    block-height: uint,
    is-late: bool,
    penalty-amount: uint,
    notes: (string-utf8 200)
  }
)

;; Private functions
(define-private (calculate-penalty (due-block uint) (current-block uint) (due-amount uint))
  ;; Simple penalty: 1% per block overdue, capped at 10%
  (let ((overdue-blocks (- current-block due-block)))
    (if (> overdue-blocks u0)
      (min (* due-amount (/ overdue-blocks u100)) (* due-amount u10))  ;; 0.01 * overdue_blocks, max 10%
      u0)
  )
)

(define-private (update-loan-status (loan-id uint))
  (let ((loan (unwrap! (map-get? loans {loan-id: loan-id}) (err ERR-LOAN-NOT-FOUND)))
        (current-block block-height)
        (all-installments-paid (fold check-all-paid (get-installment-ids loan-id) true)))  ;; Hypothetical fold over installments
    (if all-installments-paid
      (map-set loans {loan-id: loan-id} (merge loan {status: STATUS-CLOSED}))
      (if (> current-block (get-due-block-for-last-installment loan-id))  ;; Hypothetical
        (map-set loans {loan-id: loan-id} (merge loan {status: STATUS-OVERDUE}))
        (ok true)))
    ;; TODO: Call CreditHistory.clar to update score
    (ok true)
  )
)

;; Public functions
(define-public (pause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (var-set contract-paused true)
    (ok true)
  )
)

(define-public (unpause-contract)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (var-set contract-paused false)
    (ok true)
  )
)

(define-public (register-loan 
  (loan-id uint) 
  (borrower principal) 
  (lender principal) 
  (principal-amount uint) 
  (interest-rate uint) 
  (duration uint) 
  (metadata (string-utf8 500)))
  ;; Called by LoanOrigination.clar after loan acceptance
  (begin
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (is-eq tx-sender (contract-call? .loan-origination get-contract-principal)) (err ERR-UNAUTHORIZED))  ;; Hypothetical integration
    (asserts! (> principal-amount u0) (err ERR-INVALID-AMOUNT))
    (asserts! (<= (len metadata) u500) (err ERR-METADATA-TOO-LONG))
    (map-set loans
      {loan-id: loan-id}
      {
        borrower: borrower,
        lender: lender,
        principal-amount: principal-amount,
        interest-rate: interest-rate,
        duration: duration,
        start-block: block-height,
        status: STATUS-ACTIVE,
        total-repaid: u0,
        last-payment-block: u0,
        metadata: metadata
      })
    (var-set total-loans (+ (var-get total-loans) u1))
    ;; TODO: Generate repayment schedule based on duration (e.g., monthly installments)
    (ok true)
  )
)

(define-public (submit-repayment 
  (loan-id uint) 
  (installment-id uint) 
  (amount uint) 
  (notes (string-utf8 200)))
  (let ((loan (unwrap! (map-get? loans {loan-id: loan-id}) (err ERR-LOAN-NOT-FOUND)))
        (schedule (unwrap! (map-get? repayment-schedules {loan-id: loan-id, installment-id: installment-id}) (err ERR-INVALID-INSTALLMENT)))
        (current-block block-height)
        (penalty (calculate-penalty (get due-block schedule) current-block (get due-amount schedule)))
        (total-due (+ (get due-amount schedule) penalty))
        (is-late (> current-block (get due-block schedule))))
    (asserts! (not (var-get contract-paused)) (err ERR-PAUSED))
    (asserts! (is-eq tx-sender (get borrower loan)) (err ERR-UNAUTHORIZED))
    (asserts! (is-eq (get status loan) STATUS-ACTIVE) (err ERR-INVALID-LOAN-STATUS))
    (asserts! (not (get is-paid schedule)) (err ERR-LOAN-ALREADY-CLOSED))
    (asserts! (>= amount total-due) (err ERR-INVALID-AMOUNT))
    (asserts! (<= (len notes) u200) (err ERR-METADATA-TOO-LONG))
    ;; Update schedule
    (map-set repayment-schedules
      {loan-id: loan-id, installment-id: installment-id}
      (merge schedule {
        paid-amount: amount,
        paid-block: (some current-block),
        is-paid: true,
        penalty-applied: is-late
      }))
    ;; Update loan
    (map-set loans
      {loan-id: loan-id}
      (merge loan {
        total-repaid: (+ (get total-repaid loan) amount),
        last-payment-block: current-block
      }))
    ;; Log payment history
    (let ((history-id (+ (var-get total-repayments) u1)))
      (map-set payment-history
        {history-id: history-id}
        {
          loan-id: loan-id,
          installment-id: installment-id,
          payer: tx-sender,
          amount: amount,
          block-height: current-block,
          is-late: is-late,
          penalty-amount: penalty,
          notes: notes
        })
      (var-set total-repayments history-id))
    ;; Update status and credit
    (try! (update-loan-status loan-id))
    (print {event: "repayment-submitted", loan-id: loan-id, amount: amount, is-late: is-late})
    (ok true)
  )
)

(define-public (mark-as-defaulted (loan-id uint))
  (let ((loan (unwrap! (map-get? loans {loan-id: loan-id}) (err ERR-LOAN-NOT-FOUND))))
    (asserts! (is-eq tx-sender (get lender loan)) (err ERR-UNAUTHORIZED))
    (asserts! (or (is-eq (get status loan) STATUS-ACTIVE) (is-eq (get status loan) STATUS-OVERDUE)) (err ERR-INVALID-LOAN-STATUS))
    (map-set loans {loan-id: loan-id} (merge loan {status: STATUS-DEFAULTED}))
    ;; TODO: Notify CreditHistory.clar for negative update
    (print {event: "loan-defaulted", loan-id: loan-id})
    (ok true)
  )
)

;; Read-only functions
(define-read-only (get-loan-details (loan-id uint))
  (map-get? loans {loan-id: loan-id})
)

(define-read-only (get-repayment-schedule (loan-id uint) (installment-id uint))
  (map-get? repayment-schedules {loan-id: loan-id, installment-id: installment-id})
)

(define-read-only (get-payment-history (history-id uint))
  (map-get? payment-history {history-id: history-id})
)

(define-read-only (get-total-repaid (loan-id uint))
  (ok (get total-repaid (unwrap! (map-get? loans {loan-id: loan-id}) (err ERR-LOAN-NOT-FOUND))))
)

(define-read-only (is-loan-overdue (loan-id uint))
  (let ((loan (unwrap! (map-get? loans {loan-id: loan-id}) (err ERR-LOAN-NOT-FOUND)))
        (current-block block-height))
    (ok (and (is-eq (get status loan) STATUS-ACTIVE)
             (> current-block (+ (get start-block loan) (get duration loan)))))
  )
)

(define-read-only (calculate-outstanding-balance (loan-id uint))
  (let ((loan (unwrap! (map-get? loans {loan-id: loan-id}) (err ERR-LOAN-NOT-FOUND)))
        (total-due (calculate-total-due loan-id)))  ;; Hypothetical sum of all due-amounts
    (ok (- total-due (get total-repaid loan)))
  )
)

(define-read-only (get-contract-stats)
  {
    total-loans: (var-get total-loans),
    total-repayments: (var-get total-repayments),
    paused: (var-get contract-paused)
  }
)

;; Additional robust functions...
(define-public (add-repayment-installment 
  (loan-id uint) 
  (installment-id uint) 
  (due-block uint) 
  (due-amount uint))
  ;; Called by LoanOrigination during setup
  (let ((loan (unwrap! (map-get? loans {loan-id: loan-id}) (err ERR-LOAN-NOT-FOUND))))
    (asserts! (is-eq tx-sender (contract-call? .loan-origination get-contract-principal)) (err ERR-UNAUTHORIZED))
    (asserts! (> due-amount u0) (err ERR-INVALID-AMOUNT))
    (asserts! (> due-block (get start-block loan)) (err ERR-INVALID-TIMESTAMP))
    (map-set repayment-schedules
      {loan-id: loan-id, installment-id: installment-id}
      {
        due-block: due-block,
        due-amount: due-amount,
        paid-amount: u0,
        paid-block: none,
        is-paid: false,
        penalty-applied: false
      })
    (ok true)
  )
)

(define-public (transfer-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
    (var-set admin new-admin)
    (ok true)
  )
)


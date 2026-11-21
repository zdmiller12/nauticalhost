# Feature Request: Balance Accounts Widget

The goal is to add a new space to the site, 'Widgets', so the top bar becomes Home, Compendium, Professional, then Widgets.

At the top of the Widgets page should be some space for outlining the different widgets, like a drop-down menu or expandable section with summary cards about each Widget. The remainder of the page should be dedicated to the currently-selected widget.

## Widget Number One: Balance Accounts

This widget is a simple calculation tool to help distribute funds to multiple accounts such that their totals become equal, or as close to equal as is possible

- user controls the destination accounts
  - [optional] account name (_default to Account A, Account B, etc._)
  - [required] account balance
- [required] user sets the amount of money to be distributed (_use US dollars as the default, but allow users to change to any globally-recognized currency_)
- [phase 2] [optional] user controls account "priority", which defaults to equal priority for all accounts (_higher priority => more $ from distribution_)

### Simple Example A

Acct A Balance: $10
Acct B Balance: $20

Amt to Distribute: $12

#### Solution

Acct A Distribution: $11
Acct B Distribution: $1

> hint: $12 distributed and both destination accounts have equal $21 total after distribution

### Simple Example B

Acct A Balance: $10
Acct B Balance: $20

Amt to Distribute: $5

#### Solution

Acct A Distribution: $5
Acct B Distribution: $0

> hint: $5 distributed and exhausted before accounts can be made equal

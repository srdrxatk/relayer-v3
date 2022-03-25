import { BigNumber, winston, buildFillRelayProps } from "./utils";
import { SpokePoolClient } from "./clients/SpokePoolClient";
import { HubPoolClient } from "./clients/HubPoolClient";
import { RateModelClient } from "./clients/RateModelClient";
import { MulticallBundler } from "./MulticallBundler";
import { Deposit } from "./interfaces/SpokePool";

export class Relayer {
  private repaymentChainId = 1; // Set to 1 for now. In future can be dynamically set to adjust bots capital allocation.
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly multicallBundler: MulticallBundler | any
  ) {}
  async checkForUnfilledDepositsAndFill() {
    // Fetch all unfilled deposits, order by total earnable fee. Note this does not consider the price of the token
    // which will be added once the profitability module is added to this bot.
    const unfilledDeposits = this.getUnfilledDeposits().sort((a, b) =>
      a.unfilledAmount.mul(a.deposit.relayerFeePct).lt(b.unfilledAmount.mul(b.deposit.relayerFeePct)) ? 1 : -1
    );

    if (unfilledDeposits.length > 0)
      this.logger.debug({ at: "Relayer", message: "Filling deposits", number: unfilledDeposits.length });
    else this.logger.debug({ at: "Relayer", message: "No unfilled deposits" });

    // Iterate over all unfilled deposits. For each unfilled deposit add a fillRelay tx to the multicallBundler.
    for (const unfilledDeposit of unfilledDeposits) {
      const destinationToken = this.hubPoolClient.getDestinationTokenForDeposit(unfilledDeposit.deposit);
      this.multicallBundler.addTransaction(this.fillRelay(unfilledDeposit, destinationToken));
    }
  }

  // TODO: right now this method will fill the whole amount of the relay. Next iteration should consider the wallet balance.
  fillRelay(depositInfo: { unfilledAmount: BigNumber; deposit: Deposit }, destinationToken: string) {
    this.logger.debug({ at: "Relayer", message: "Filling deposit", depositInfo, destinationToken });
    return this.getDestinationSpokePoolForDeposit(depositInfo.deposit).fillRelay(
      ...buildFillRelayProps(depositInfo, this.repaymentChainId)
    );
  }

  getDestinationSpokePoolForDeposit(deposit: Deposit) {
    return this.spokePoolClients[deposit.destinationChainId].spokePool;
  }

  // Returns all unfilled deposits over all spokePoolClients. Return values include the amount of the unfilled deposit.
  getUnfilledDeposits() {
    let unfilledDeposits: { unfilledAmount: BigNumber; deposit: Deposit }[] = [];
    // Iterate over each chainId and check for unfilled deposits.
    const chainIds = Object.keys(this.spokePoolClients);
    for (const originChain of chainIds) {
      const originClient = this.spokePoolClients[originChain];
      for (const destinationChain of chainIds) {
        if (originChain === destinationChain) continue;
        // Find all unfilled deposits for the current loops originChain -> destinationChain. Note that this also
        // validates that the deposit is filled "correctly" for the given deposit information. This includes validation
        // of the all deposit -> relay props, the realizedLpFeePct and the origin->destination token mapping.
        const destinationClient = this.spokePoolClients[destinationChain];
        const depositsForDestinationChain = originClient.getDepositsForDestinationChain(destinationChain);
        const unfilledDepositsForDestinationChain = depositsForDestinationChain.map((deposit) => {
          return { unfilledAmount: destinationClient.getValidUnfilledAmountForDeposit(deposit), deposit };
        });
        // Remove any deposits that have no unfilled amount (i.e that have an unfilled amount of 0) and append the
        // remaining deposits to the unfilledDeposits array.
        unfilledDeposits.push(...unfilledDepositsForDestinationChain.filter((deposit) => deposit.unfilledAmount.gt(0)));
      }
    }

    return unfilledDeposits;
  }
}

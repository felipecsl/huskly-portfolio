import { ParsedPosition } from "@/types/schwab";
import { AssetList } from "./AssetList";
import { PercentageChange } from "./PercentageChange";
import { formatPrice } from "@/lib/utils/format";

interface AssetTypeTableProps {
  positions: ParsedPosition[];
  type: "stock" | "option";
  title: string;
  itemLabel?: string;
}

export const AssetTypeTable = ({
  positions,
  type,
  title,
  itemLabel = "holdings",
}: AssetTypeTableProps) => {
  const filteredPositions = positions.filter(
    (position) => position.type === type,
  );

  if (filteredPositions.length === 0) {
    return null;
  }

  const totalValue = filteredPositions.reduce(
    (sum, position) => sum + position.value,
    0,
  );

  const totalDayChange =
    (filteredPositions.reduce(
      (sum, position) =>
        sum + (position.value * parseFloat(position.changePercent24Hr)) / 100,
      0,
    ) /
      totalValue) *
    100;

  return (
    <div className="mb-8 brutal-border bg-stone-900 rounded-lg overflow-hidden text-gray-300">
      <div className="px-6 pt-6 flex justify-between items-start">
        <div>
          <h2 className="text-2xl font-medium text-white">{title}</h2>
          <p className="text-gray-400">
            {filteredPositions.length} {itemLabel}
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-medium text-white">
            {formatPrice(totalValue)}
          </div>
          <div className="mt-2">
            <PercentageChange value={totalDayChange} />
          </div>
        </div>
      </div>
      <AssetList assets={filteredPositions} />
    </div>
  );
};

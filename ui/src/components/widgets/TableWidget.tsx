import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { memo, useMemo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { TableConfig, WidgetData } from "@/types/widget";

interface TableWidgetProps {
  data: WidgetData;
  config: TableConfig;
}

export const TableWidget = memo(function TableWidget({
  data,
  config,
}: TableWidgetProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const pageSize = config.pageSize || 50;

  const tableData = useMemo(
    () => data.rows.slice(0, pageSize),
    [data.rows, pageSize],
  );

  const columns = useMemo<ColumnDef<Record<string, any>>[]>(
    () =>
      data.columns.map((col) => ({
        accessorKey: col,
        header: col,
        cell: (info) => {
          const val = info.getValue();
          return val != null ? (
            <span className="text-xs font-mono text-slate-300">
              {String(val)}
            </span>
          ) : (
            <span className="text-slate-600">null</span>
          );
        },
      })),
    [data.columns],
  );

  const table = useReactTable({
    data: tableData,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="overflow-auto max-h-80">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow
              key={hg.id}
              className="border-slate-800 hover:bg-transparent"
            >
              {hg.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <TableHead
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="cursor-pointer text-[10px] uppercase tracking-widest font-black text-slate-500 hover:text-slate-300 whitespace-nowrap"
                  >
                    <span className="flex items-center gap-1">
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                      {sorted === "asc" ? (
                        <ArrowUp className="w-3 h-3" />
                      ) : sorted === "desc" ? (
                        <ArrowDown className="w-3 h-3" />
                      ) : (
                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                      )}
                    </span>
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className="border-slate-800/50 hover:bg-slate-800/30"
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className="py-2 whitespace-nowrap">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {data.rows.length > pageSize && (
        <div className="text-[10px] text-slate-500 p-2 text-center border-t border-slate-800">
          Showing {pageSize} of {data.rows.length} rows
        </div>
      )}
    </div>
  );
});

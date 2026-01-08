import { Activity, Folder, Server } from "lucide-react";
import { trpc } from "../utils/trpc";

export function ProjectOverview() {
    // 1. QUERY: Fetch data automatically on mount
    // "data" is typed! Hover over it to see { cwd: string, nodeVersion: string }
    const projectQuery = trpc.getProjectInfo.useQuery();

    // 2. MUTATION: A function we call manually (e.g., on button click)
    // Let's assume you added a 'runScan' mutation to your router
    /* const scanMutation = trpc.runScan.useMutation({
    onSuccess: (result) => {
      console.log('Scan finished:', result);
    }
  }); 
  */

    if (projectQuery.isLoading) {
        return <div className="p-4 text-gray-500">Loading project context...</div>;
    }

    if (projectQuery.isError) {
        return (
            <div className="p-4 text-red-500 bg-red-50 border border-red-200 rounded">
                Error connecting to Raiken CLI: {projectQuery.error.message}
            </div>
        );
    }

    // At this point, projectQuery.data is guaranteed to be defined
    const { path: cwd, nodeVersion } = projectQuery.data!;

    return (
        <div className="p-6 bg-white rounded-lg shadow-sm border border-gray-200">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Activity className="text-blue-600" />
                Raiken Status
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Card 1: Project Path */}
                <div className="p-4 bg-gray-50 rounded border border-gray-100">
                    <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                        <Folder size={16} />
                        <span>Active Project</span>
                    </div>
                    <code className="text-sm font-mono bg-gray-200 px-1 py-0.5 rounded text-gray-800">
                        {cwd}
                    </code>
                </div>

                {/* Card 2: Engine Info */}
                <div className="p-4 bg-gray-50 rounded border border-gray-100">
                    <div className="flex items-center gap-2 text-sm text-gray-500 mb-1">
                        <Server size={16} />
                        <span>Node Engine</span>
                    </div>
                    <span className="font-medium text-gray-900">{nodeVersion}</span>
                </div>
            </div>

            {/* Example Button for a mutation */}
            <div className="mt-4 pt-4 border-t border-gray-100">
                <button
                    className="px-4 py-2 bg-black text-white rounded hover:bg-gray-800 text-sm font-medium"
                    onClick={() => {
                        // scanMutation.mutate({ path: cwd });
                        alert("Scan triggered! (Implement mutation in router first)");
                    }}
                >
                    Run Full Scan
                </button>
            </div>
        </div>
    );
}

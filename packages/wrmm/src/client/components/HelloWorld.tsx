import { useHealth, useHello } from '../hooks/useApi';

export const HelloWorld = () => {
  const { data: healthData, isLoading: healthLoading, error: healthError } = useHealth();
  const { data: helloData, isLoading: helloLoading, error: helloError } = useHello();

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="max-w-2xl w-full bg-white rounded-2xl shadow-xl p-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            🚀 Hello World!
          </h1>
          <p className="text-lg text-gray-600">
            Welcome to your React + TypeScript + Express application
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Health Status Card */}
          <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl p-6 border border-green-200">
            <h2 className="text-xl font-semibold text-green-800 mb-4 flex items-center">
              <span className="w-3 h-3 bg-green-500 rounded-full mr-2"></span>
              Server Health
            </h2>
            
            {healthLoading && (
              <div className="flex items-center text-green-700">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-600 mr-2"></div>
                Checking server status...
              </div>
            )}
            
            {healthError && (
              <div className="text-red-600">
                ❌ Error: {healthError.message}
              </div>
            )}
            
            {healthData && (
              <div className="space-y-2">
                <p className="text-green-700 font-medium">{healthData.message}</p>
                <p className="text-sm text-green-600">
                  Last checked: {new Date(healthData.timestamp).toLocaleTimeString()}
                </p>
              </div>
            )}
          </div>

          {/* Hello API Card */}
          <div className="bg-gradient-to-r from-blue-50 to-cyan-50 rounded-xl p-6 border border-blue-200">
            <h2 className="text-xl font-semibold text-blue-800 mb-4 flex items-center">
              <span className="w-3 h-3 bg-blue-500 rounded-full mr-2"></span>
              Backend Message
            </h2>
            
            {helloLoading && (
              <div className="flex items-center text-blue-700">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>
                Loading message...
              </div>
            )}
            
            {helloError && (
              <div className="text-red-600">
                ❌ Error: {helloError.message}
              </div>
            )}
            
            {helloData && (
              <div className="space-y-2">
                <p className="text-blue-700 font-medium">{helloData.message}</p>
                <div className="text-sm text-blue-600 space-y-1">
                  <p>Server Time: {new Date(helloData.data.serverTime).toLocaleString()}</p>
                  <p>Environment: {helloData.data.environment}</p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-8 text-center">
          <div className="inline-flex items-center space-x-2 bg-gray-100 rounded-full px-4 py-2">
            <span className="text-sm font-medium text-gray-700">Built with:</span>
            <span className="bg-blue-100 text-blue-800 text-xs font-medium px-2 py-1 rounded">React 19</span>
            <span className="bg-green-100 text-green-800 text-xs font-medium px-2 py-1 rounded">TypeScript</span>
            <span className="bg-purple-100 text-purple-800 text-xs font-medium px-2 py-1 rounded">Tailwind v4</span>
            <span className="bg-orange-100 text-orange-800 text-xs font-medium px-2 py-1 rounded">TanStack Query</span>
            <span className="bg-red-100 text-red-800 text-xs font-medium px-2 py-1 rounded">Express</span>
          </div>
        </div>
      </div>
    </div>
  );
}; 
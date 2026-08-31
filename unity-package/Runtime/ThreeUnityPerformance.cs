using System;

namespace ThreeUnity.Performance
{
    /// <summary>Small workload API available to benchmark scenarios at runtime.</summary>
    public static class ThreeUnityPerformance
    {
        internal static event Action<string, bool> CheckpointRecorded;

        public static void Checkpoint(string name, bool value = true)
        {
            if (string.IsNullOrWhiteSpace(name))
                throw new ArgumentException("Checkpoint name cannot be empty.", nameof(name));
            CheckpointRecorded?.Invoke(name, value);
        }
    }
}

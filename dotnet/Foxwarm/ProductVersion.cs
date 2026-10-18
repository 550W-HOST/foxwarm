using System.Reflection;

namespace Foxwarm;

internal static class ProductVersion
{
    internal static string Value => typeof(ProductVersion).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()!.InformationalVersion;
}

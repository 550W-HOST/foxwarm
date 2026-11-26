using System.Collections.Immutable;
using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

namespace Foxwarm.Tests.Net;

/// <summary>
/// Reads the IL of a compiled assembly for the outbound-connection constructs the egress rule
/// forbids. It sees what the compiler emitted, so spelling (target-typed <c>new()</c>,
/// expression bodies, aliases, fully qualified names) makes no difference.
/// </summary>
internal static class EgressIlScan
{
    /// <summary>One forbidden construct: the top-level type and method that emit it.</summary>
    internal sealed record Hit(string Type, string Method, string Construct)
    {
        public override string ToString() => $"{Type}.{Method}: {Construct}";
    }

    // Constructors of types that open outbound connections themselves.
    private static readonly HashSet<string> ForbiddenConstructors = new(StringComparer.Ordinal)
    {
        "System.Net.Http.HttpClient",
        "System.Net.Http.SocketsHttpHandler",
        "System.Net.Http.HttpClientHandler",
        "System.Net.WebSockets.ClientWebSocket",
        "System.Net.Sockets.Socket",
        "System.Net.Sockets.TcpClient",
        "System.Net.Sockets.UdpClient",
        "System.Net.Security.SslStream",
    };

    private static readonly Dictionary<short, OperandType> Operands = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Select(field => (OpCode)field.GetValue(null)!)
        .ToDictionary(code => code.Value, code => code.OperandType);

    internal static IReadOnlyList<Hit> Scan(string assemblyPath, Func<string, bool>? types = null)
    {
        using var stream = File.OpenRead(assemblyPath);
        using var pe = new PEReader(stream);
        var reader = pe.GetMetadataReader();
        var hits = new List<Hit>();
        // Own terminal handlers (direct HttpMessageHandler subclasses) count as forbidden too.
        var ownHandlers = reader
            .TypeDefinitions.Select(handle => reader.GetTypeDefinition(handle))
            .Where(type => TypeName(reader, type.BaseType) == "System.Net.Http.HttpMessageHandler")
            .Select(type => FullName(reader, type))
            .ToHashSet(StringComparer.Ordinal);
        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var type = reader.GetTypeDefinition(typeHandle);
            var owner = TopLevel(reader, type);
            if (types is not null && !types(owner))
                continue;
            foreach (var methodHandle in type.GetMethods())
            {
                var method = reader.GetMethodDefinition(methodHandle);
                if (method.RelativeVirtualAddress == 0)
                    continue;
                var body = pe.GetMethodBody(method.RelativeVirtualAddress);
                // A closure or state machine names the method it came from.
                var full = FullName(reader, type);
                var methodName =
                    (full.Length > owner.Length ? full[(owner.Length + 1)..] + "." : "")
                    + reader.GetString(method.Name);
                foreach (var construct in Constructs(reader, body.GetILBytes()!, ownHandlers))
                    hits.Add(new Hit(owner, methodName, construct));
            }
        }
        return hits;
    }

    private static IEnumerable<string> Constructs(
        MetadataReader reader,
        byte[] il,
        HashSet<string> ownHandlers
    )
    {
        var offset = 0;
        while (offset < il.Length)
        {
            short value = il[offset++];
            if (value == 0xFE)
                value = unchecked((short)(0xFE00 | il[offset++]));
            var operand = Operands[value];
            var size = operand switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                OperandType.InlineSwitch => 4 + 4 * BitConverter.ToInt32(il, offset),
                _ => 4,
            };
            if (operand is OperandType.InlineMethod or OperandType.InlineField)
            {
                var token = BitConverter.ToInt32(il, offset);
                var (declaring, name, parameters) = Member(reader, MetadataTokens.EntityHandle(token));
                if (value == OpCodes.Newobj.Value)
                {
                    if (ForbiddenConstructors.Contains(declaring) || ownHandlers.Contains(declaring))
                        yield return "new " + declaring;
                    // The MCP SDK transport must be given the factory's client.
                    if (
                        declaring == "ModelContextProtocol.Client.HttpClientTransport"
                        && !parameters.Contains("System.Net.Http.HttpClient")
                    )
                        yield return "new " + declaring + " without a client";
                }
                else if (
                    (value == OpCodes.Call.Value || value == OpCodes.Callvirt.Value)
                    && declaring == "System.Net.WebSockets.ClientWebSocket"
                    && name == "ConnectAsync"
                    && !parameters.Contains("System.Net.Http.HttpMessageInvoker")
                )
                    yield return "ClientWebSocket.ConnectAsync without an invoker";
                else if (declaring == "System.Net.HttpVersion" && name == "Version30")
                    yield return "HttpVersion.Version30";
                else if (
                    name is "set_DefaultVersionPolicy" or "set_DefaultRequestVersion"
                    && declaring == "System.Net.Http.HttpClient"
                )
                    yield return "HttpClient." + name[4..];
            }
            offset += size;
        }
    }

    private static (string Declaring, string Name, ImmutableArray<string> Parameters) Member(
        MetadataReader reader,
        EntityHandle handle
    )
    {
        switch (handle.Kind)
        {
            case HandleKind.MethodDefinition:
            {
                var method = reader.GetMethodDefinition((MethodDefinitionHandle)handle);
                var signature = method.DecodeSignature(Names.Instance, null);
                return (
                    FullName(reader, reader.GetTypeDefinition(method.GetDeclaringType())),
                    reader.GetString(method.Name),
                    signature.ParameterTypes
                );
            }
            case HandleKind.MemberReference:
            {
                var member = reader.GetMemberReference((MemberReferenceHandle)handle);
                var name = reader.GetString(member.Name);
                var parameters =
                    member.GetKind() == MemberReferenceKind.Method
                        ? member.DecodeMethodSignature(Names.Instance, null).ParameterTypes
                        : [];
                return (TypeName(reader, member.Parent), name, parameters);
            }
            case HandleKind.MethodSpecification:
                return Member(
                    reader,
                    reader.GetMethodSpecification((MethodSpecificationHandle)handle).Method
                );
            case HandleKind.FieldDefinition:
            {
                var field = reader.GetFieldDefinition((FieldDefinitionHandle)handle);
                return (
                    FullName(reader, reader.GetTypeDefinition(field.GetDeclaringType())),
                    reader.GetString(field.Name),
                    []
                );
            }
            default:
                return ("", "", []);
        }
    }

    private static string TypeName(MetadataReader reader, EntityHandle handle) =>
        handle.IsNil ? ""
        : handle.Kind switch
        {
            HandleKind.TypeReference => RefName(reader, (TypeReferenceHandle)handle),
            HandleKind.TypeDefinition => FullName(
                reader,
                reader.GetTypeDefinition((TypeDefinitionHandle)handle)
            ),
            HandleKind.TypeSpecification => reader
                .GetTypeSpecification((TypeSpecificationHandle)handle)
                .DecodeSignature(Names.Instance, null),
            _ => "",
        };

    private static string RefName(MetadataReader reader, TypeReferenceHandle handle)
    {
        var type = reader.GetTypeReference(handle);
        var name = reader.GetString(type.Name);
        if (type.ResolutionScope.Kind == HandleKind.TypeReference)
            return RefName(reader, (TypeReferenceHandle)type.ResolutionScope) + "+" + name;
        var space = reader.GetString(type.Namespace);
        return space.Length == 0 ? name : space + "." + name;
    }

    private static string FullName(MetadataReader reader, TypeDefinition type)
    {
        var name = reader.GetString(type.Name);
        var declaring = type.GetDeclaringType();
        if (!declaring.IsNil)
            return FullName(reader, reader.GetTypeDefinition(declaring)) + "+" + name;
        var space = reader.GetString(type.Namespace);
        return space.Length == 0 ? name : space + "." + name;
    }

    // Compiler-generated closures and state machines belong to the type that declares them.
    private static string TopLevel(MetadataReader reader, TypeDefinition type)
    {
        while (!type.GetDeclaringType().IsNil)
            type = reader.GetTypeDefinition(type.GetDeclaringType());
        return FullName(reader, type);
    }

    private sealed class Names : ISignatureTypeProvider<string, object?>
    {
        internal static readonly Names Instance = new();

        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[,]";

        public string GetByReferenceType(string elementType) => elementType + "&";

        public string GetFunctionPointerType(MethodSignature<string> signature) => "fnptr";

        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) =>
            genericType;

        public string GetGenericMethodParameter(object? genericContext, int index) => "!!" + index;

        public string GetGenericTypeParameter(object? genericContext, int index) => "!" + index;

        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) =>
            unmodifiedType;

        public string GetPinnedType(string elementType) => elementType;

        public string GetPointerType(string elementType) => elementType + "*";

        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();

        public string GetSZArrayType(string elementType) => elementType + "[]";

        public string GetTypeFromDefinition(
            MetadataReader reader,
            TypeDefinitionHandle handle,
            byte rawTypeKind
        ) => FullName(reader, reader.GetTypeDefinition(handle));

        public string GetTypeFromReference(
            MetadataReader reader,
            TypeReferenceHandle handle,
            byte rawTypeKind
        ) => RefName(reader, handle);

        public string GetTypeFromSpecification(
            MetadataReader reader,
            object? genericContext,
            TypeSpecificationHandle handle,
            byte rawTypeKind
        ) => reader.GetTypeSpecification(handle).DecodeSignature(this, genericContext);
    }
}

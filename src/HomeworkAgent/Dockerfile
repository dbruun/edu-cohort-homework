FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY HomeworkAgent.csproj ./
RUN dotnet restore HomeworkAgent.csproj
COPY . ./
RUN dotnet publish HomeworkAgent.csproj -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app ./
EXPOSE 8088
ENTRYPOINT ["dotnet", "HomeworkAgent.dll"]

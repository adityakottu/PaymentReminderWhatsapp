Attribute VB_Name = "BulkReminderPrep"
' =============================================================================
' Bulk WhatsApp Reminder – OPTIONAL Excel preparation macro
'
' This macro ONLY prepares and checks the spreadsheet. It never sends anything.
' Import, validation, queueing, WhatsApp sending, retries, status tracking,
' audit and reports are all done by the application.
'
' What it does (active sheet, header in row 1):
'   1. Maps common header names to the application's expected headers.
'   2. Trims spaces; removes spaces/dashes/brackets from phone numbers.
'   3. Formats Indian mobiles as 91XXXXXXXXXX (text format, no "+").
'   4. Highlights invalid rows (red) and duplicates (orange) with a reason
'      in a "Prep Notes" column.
'   5. Optionally deletes exact duplicate rows.
'   6. Writes totals (rows, valid, invalid, duplicates, total amount due).
'
' Install: Alt+F11 → File → Import File… → BulkReminderPrep.bas
' Run:     Alt+F8  → PrepareBulkReminderSheet
' =============================================================================
Option Explicit

Private Const COL_NAME As String = "Customer Name"
Private Const COL_PHONE As String = "Phone Number"
Private Const COL_AMOUNT As String = "Amount Due"
Private Const COL_DUE As String = "Due Date"
Private Const COL_ACCOUNT As String = "Loan/Account ID"
Private Const COL_INST As String = "Installment Number"
Private Const COL_EMP As String = "Employee/Collector"
Private Const COL_MSG As String = "Custom Message"
Private Const COL_NOTES As String = "Prep Notes"

Public Sub PrepareBulkReminderSheet()
    Dim ws As Worksheet: Set ws = ActiveSheet
    Application.ScreenUpdating = False

    NormaliseHeaders ws
    Dim cName As Long, cPhone As Long, cAmount As Long, cDue As Long, cAcc As Long, cInst As Long, cNotes As Long
    cName = FindCol(ws, COL_NAME)
    cPhone = FindCol(ws, COL_PHONE)
    cAmount = FindCol(ws, COL_AMOUNT)
    cDue = FindCol(ws, COL_DUE)
    cAcc = FindCol(ws, COL_ACCOUNT)
    cInst = FindCol(ws, COL_INST)
    If cName = 0 Or cPhone = 0 Or cAmount = 0 Then
        Application.ScreenUpdating = True
        MsgBox "Missing required column(s). Required: " & COL_NAME & ", " & COL_PHONE & ", " & COL_AMOUNT, vbExclamation
        Exit Sub
    End If
    cNotes = FindCol(ws, COL_NOTES)
    If cNotes = 0 Then
        cNotes = ws.Cells(1, ws.Columns.Count).End(xlToLeft).Column + 1
        ws.Cells(1, cNotes).Value = COL_NOTES
    End If

    Dim lastRow As Long: lastRow = LastDataRow(ws)
    ws.Columns(cPhone).NumberFormat = "@"
    ws.Range(ws.Cells(2, 1), ws.Cells(Application.Max(lastRow, 2), cNotes)).Interior.ColorIndex = xlNone

    Dim seen As Object: Set seen = CreateObject("Scripting.Dictionary")
    Dim r As Long, nValid As Long, nInvalid As Long, nDup As Long, total As Double
    Dim reason As String, phone As String, key As String, amt As Variant

    For r = 2 To lastRow
        If Application.WorksheetFunction.CountA(ws.Rows(r)) = 0 Then GoTo NextRow
        reason = ""
        ws.Cells(r, cName).Value = Trim$(CStr(ws.Cells(r, cName).Value))
        If ws.Cells(r, cName).Value = "" Then reason = AddReason(reason, "Customer name missing")

        phone = NormalisePhone(CStr(ws.Cells(r, cPhone).Text))
        If Left$(phone, 1) = "!" Then
            reason = AddReason(reason, Mid$(phone, 2))
        Else
            ws.Cells(r, cPhone).Value = phone
        End If

        amt = Replace(Replace(Replace(CStr(ws.Cells(r, cAmount).Value), ",", ""), ChrW(8377), ""), " ", "")
        If amt = "" Then
            reason = AddReason(reason, "Amount missing")
        ElseIf Not IsNumeric(amt) Then
            reason = AddReason(reason, "Amount is not a number")
        ElseIf CDbl(amt) < 0 Then
            reason = AddReason(reason, "Amount cannot be negative")
        Else
            ws.Cells(r, cAmount).Value = CDbl(amt)
        End If

        If cDue > 0 Then
            If Trim$(CStr(ws.Cells(r, cDue).Value)) <> "" Then
                If IsDate(ws.Cells(r, cDue).Value) Then
                    ws.Cells(r, cDue).Value = Format$(CDate(ws.Cells(r, cDue).Value), "dd-mm-yyyy")
                    ws.Cells(r, cDue).NumberFormat = "@"
                Else
                    reason = AddReason(reason, "Invalid due date (use DD-MM-YYYY)")
                End If
            End If
        End If

        If reason = "" Then
            key = phone & "|" & IIf(cAcc > 0, LCase$(Trim$(CStr(ws.Cells(r, IIf(cAcc > 0, cAcc, 1)).Value))), "") & "|" & IIf(cInst > 0, Trim$(CStr(ws.Cells(r, IIf(cInst > 0, cInst, 1)).Value)), "")
            If seen.Exists(key) Then
                ws.Cells(r, cNotes).Value = "Duplicate of row " & seen(key)
                ws.Rows(r).Interior.Color = RGB(255, 220, 170)
                nDup = nDup + 1
            Else
                seen.Add key, r
                ws.Cells(r, cNotes).Value = "OK"
                nValid = nValid + 1
                total = total + CDbl(ws.Cells(r, cAmount).Value)
            End If
        Else
            ws.Cells(r, cNotes).Value = reason
            ws.Rows(r).Interior.Color = RGB(255, 205, 205)
            nInvalid = nInvalid + 1
        End If
NextRow:
    Next r

    Application.ScreenUpdating = True
    Dim msg As String
    msg = "Rows checked: " & (nValid + nInvalid + nDup) & vbCrLf & _
          "Valid: " & nValid & vbCrLf & "Invalid (red): " & nInvalid & vbCrLf & _
          "Duplicates (orange): " & nDup & vbCrLf & _
          "Total amount due (valid rows): " & Format$(total, "#,##0.00") & vbCrLf & vbCrLf & _
          "Delete duplicate rows now?"
    If nDup > 0 Then
        If MsgBox(msg, vbYesNo + vbInformation, "Bulk reminder prep") = vbYes Then DeleteDuplicateRows ws, cNotes
    Else
        MsgBox Replace(msg, vbCrLf & vbCrLf & "Delete duplicate rows now?", ""), vbInformation, "Bulk reminder prep"
    End If
End Sub

' Returns 91XXXXXXXXXX, or "!reason" when invalid. International numbers are left to the application.
Private Function NormalisePhone(ByVal s As String) As String
    Dim i As Long, ch As String, digits As String, plus As Boolean
    s = Trim$(s)
    If s = "" Then NormalisePhone = "!Phone number missing": Exit Function
    If InStr(1, s, "E+", vbTextCompare) > 0 Then NormalisePhone = "!Phone in scientific notation – format column as Text and re-enter": Exit Function
    plus = (Left$(s, 1) = "+")
    For i = 1 To Len(s)
        ch = Mid$(s, i, 1)
        If ch Like "#" Then
            digits = digits & ch
        ElseIf InStr(" -().", ch) = 0 And Not (i = 1 And ch = "+") Then
            NormalisePhone = "!Phone number contains invalid characters": Exit Function
        End If
    Next i
    If Not plus And Left$(digits, 2) = "00" Then digits = Mid$(digits, 3): plus = True
    If plus And Left$(digits, 2) <> "91" Then NormalisePhone = digits: Exit Function ' international – app decides
    If Len(digits) = 11 And Left$(digits, 1) = "0" Then digits = Mid$(digits, 2)
    If Len(digits) = 12 And Left$(digits, 2) = "91" Then digits = Mid$(digits, 3)
    If Len(digits) < 10 Then NormalisePhone = "!Phone number incomplete": Exit Function
    If Len(digits) > 10 Then NormalisePhone = "!Phone number has too many digits": Exit Function
    If InStr("6789", Left$(digits, 1)) = 0 Then NormalisePhone = "!Invalid Indian mobile number": Exit Function
    NormalisePhone = "91" & digits
End Function

Private Sub NormaliseHeaders(ws As Worksheet)
    Dim c As Long, h As String
    For c = 1 To ws.Cells(1, ws.Columns.Count).End(xlToLeft).Column
        h = LCase$(Replace(Replace(Replace(Trim$(CStr(ws.Cells(1, c).Value)), " ", ""), "/", ""), "_", ""))
        Select Case h
            Case "customername", "customer", "name", "borrowername": ws.Cells(1, c).Value = COL_NAME
            Case "phonenumber", "phone", "mobile", "mobilenumber", "mobileno", "whatsappnumber": ws.Cells(1, c).Value = COL_PHONE
            Case "amountdue", "amount", "dueamount", "pendingamount": ws.Cells(1, c).Value = COL_AMOUNT
            Case "duedate", "date": ws.Cells(1, c).Value = COL_DUE
            Case "loanaccountid", "loanid", "accountid", "account", "loanno", "accountno": ws.Cells(1, c).Value = COL_ACCOUNT
            Case "installmentnumber", "installment", "emi", "emino": ws.Cells(1, c).Value = COL_INST
            Case "employeecollector", "employee", "collector", "agent": ws.Cells(1, c).Value = COL_EMP
            Case "custommessage", "message", "remarks", "note": ws.Cells(1, c).Value = COL_MSG
        End Select
    Next c
    ws.Rows(1).Font.Bold = True
End Sub

Private Sub DeleteDuplicateRows(ws As Worksheet, cNotes As Long)
    Dim r As Long
    For r = LastDataRow(ws) To 2 Step -1
        If Left$(CStr(ws.Cells(r, cNotes).Value), 12) = "Duplicate of" Then ws.Rows(r).Delete
    Next r
End Sub

Private Function FindCol(ws As Worksheet, header As String) As Long
    Dim c As Long
    For c = 1 To ws.Cells(1, ws.Columns.Count).End(xlToLeft).Column
        If StrComp(Trim$(CStr(ws.Cells(1, c).Value)), header, vbTextCompare) = 0 Then FindCol = c: Exit Function
    Next c
End Function

Private Function LastDataRow(ws As Worksheet) As Long
    LastDataRow = ws.Cells.Find(What:="*", LookIn:=xlFormulas, SearchOrder:=xlByRows, SearchDirection:=xlPrevious).Row
End Function

Private Function AddReason(ByVal existing As String, ByVal reason As String) As String
    If existing = "" Then AddReason = reason Else AddReason = existing & "; " & reason
End Function
